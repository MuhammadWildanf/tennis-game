using System.Collections;
using UnityEngine;
using UnityEngine.UI; // ganti ke TMPro jika pakai TextMeshPro

/// <summary>
/// SESSION CONTROLLER - bukan gameplay tennis.
/// Tugas: Home idle -> polling queue -> deteksi usher pick -> claim-turn -> trigger gameplay -> submit score.
/// Gameplay tennis asli (bola/raket/AI) ada di script terpisah, panggil SubmitScoreAndReturn() saat selesai.
/// Flow fix: server.js usher-driven, Unity hanya polling + claim-turn.
/// </summary>
public class TennisSessionController : MonoBehaviour
{
    [Header("API")]
    public TennisApiClient api; // drag dari scene, atau otomatis Instance

    [Header("Polling")]
    public float statePollInterval = 2f;
    public float leaderboardRefreshInterval = 15f;

    [Header("UI - Home (optional, bisa null)")]
    public GameObject homePanel;
    public GameObject gamePanel;
    public RawImage qrImage;
    public Text statusText;
    public Text nowPlayingText;
    public Text waitingText;
    public Text leaderboardText;

    // State internal
    string rememberedUsername = null;
    string turnToken = null;
    bool isPlaying = false;
    Coroutine pollRoutine;

    const string PREF_TURN_TOKEN = "turn_token";
    const string PREF_USERNAME = "remembered_username";

    void Start()
    {
        if (api == null) api = TennisApiClient.Instance;
        if (api == null) { Debug.LogError("[Flow] TennisApiClient belum ada di scene."); return; }

        // Load token terakhir (untuk resume aman - claim-turn idempotent)
        turnToken = PlayerPrefs.GetString(PREF_TURN_TOKEN, null);
        rememberedUsername = PlayerPrefs.GetString(PREF_USERNAME, null);
        if (string.IsNullOrEmpty(turnToken)) turnToken = null;
        if (string.IsNullOrEmpty(rememberedUsername)) rememberedUsername = null;

        StartCoroutine(BootSequence());
    }

    IEnumerator BootSequence()
    {
        SetStatus("Checking server...");
        bool done = false, ok = false;
        api.CheckStatus(
            res => { ok = res.ok; done = true; Debug.Log($"[Boot] status {res.version} {res.server_time}"); },
            err => { done = true; Debug.LogWarning("[Boot] " + err); }
        );
        yield return new WaitUntil(() => done);

        if (!ok)
        {
            SetStatus("Server offline - cek BASE URL & WiFi");
            yield break;
        }

        SetStatus("Server OK");
        ShowHome(true);
        RefreshQR();
        pollRoutine = StartCoroutine(PollLoop());
        StartCoroutine(LeaderboardLoop());
    }

    // Polling utama: tiap 2 detik cek siapa yang di-pick usher
    IEnumerator PollLoop()
    {
        while (true)
        {
            if (isPlaying) { yield return new WaitForSeconds(statePollInterval); continue; }

            bool reqDone = false;
            QueueState state = null;
            string errMsg = null;

            api.GetQueueState(s => { state = s; reqDone = true; }, e => { errMsg = e; reqDone = true; });
            yield return new WaitUntil(() => reqDone);

            if (state != null)
            {
                UpdateHomeUI(state);

                if (state.current == null)
                {
                    // Idle: tunggu usher pick
                }
                else if (state.current.username != rememberedUsername)
                {
                    // Usher baru pick pemain -> claim token -> langsung main
                    yield return StartCoroutine(ClaimAndStart(state.current.username));
                }
            }
            else if (errMsg != null)
            {
                Debug.LogWarning("[Poll] " + errMsg);
            }

            yield return new WaitForSeconds(statePollInterval);
        }
    }

    IEnumerator ClaimAndStart(string newUsername)
    {
        SetStatus($"Claiming turn for {newUsername}...");
        bool done = false;
        ClaimResponse claim = null;
        long code = 0;
        string err = null;

        api.ClaimTurn(s => { claim = s; done = true; }, (c, e) => { code = c; err = e; done = true; });
        yield return new WaitUntil(() => done);

        if (claim != null)
        {
            turnToken = claim.token;
            rememberedUsername = claim.user.username;
            PlayerPrefs.SetString(PREF_TURN_TOKEN, turnToken);
            PlayerPrefs.SetString(PREF_USERNAME, rememberedUsername);
            PlayerPrefs.Save();
            Debug.Log($"[Claim] {rememberedUsername} token {turnToken.Substring(0, 8)}...");
            StartGame(rememberedUsername);
        }
        else
        {
            // 404 = belum ada yang main, 409 = turn sudah selesai -> tunggu pick berikut
            Debug.LogWarning($"[Claim] {code} {err}");
            if (code == 409) rememberedUsername = newUsername; // hindari loop claim spam
        }
    }

    void StartGame(string username)
    {
        isPlaying = true;
        ShowHome(false);
        SetStatus($"Now playing: {username}");
        Debug.Log($"[Game] START untuk {username} - token disimpan, jangan ganti mid-game!");

        // TODO: panggil gameplay asli kamu di sini, contoh:
        // FindObjectOfType<TennisMatch>().StartMatch(username, (score, result) => SubmitScoreAndReturn(score, result));
        // Game tidak akan auto-finish. Gameplay kamu yang harus panggil SubmitScoreAndReturn() saat match selesai.
    }

    /// <summary>Panggil ini saat game selesai beneran. Token hangus setelah sukses.</summary>
    public Coroutine SubmitScoreAndReturn(int score, string result) => StartCoroutine(SubmitScoreRoutine(score, result));

    IEnumerator SubmitScoreRoutine(int score, string result)
    {
        if (string.IsNullOrEmpty(turnToken))
        {
            Debug.LogError("[Score] Tidak ada turnToken - claim-turn belum dipanggil!");
            isPlaying = false;
            ShowHome(true);
            yield break;
        }

        SetStatus($"Submitting score {score} ({result})...");
        bool done = false;
        ScoreResponse resp = null;
        long code = 0;
        string err = null;

        api.SubmitScore(score, result, "AI", turnToken,
            s => { resp = s; done = true; },
            (c, e) => { code = c; err = e; done = true; });
        yield return new WaitUntil(() => done);

        if (resp != null && resp.success)
        {
            Debug.Log($"[Score] OK match {resp.match_id}");
        }
        else
        {
            // 401 = token hangus = skor kemungkinan sudah masuk -> JANGAN resubmit, cek leaderboard
            Debug.LogWarning($"[Score] {code} {err}");
        }

        // Bersihkan token giliran (sekali pakai) -> balik polling tunggu staff pick berikut
        turnToken = null;
        rememberedUsername = null;
        PlayerPrefs.DeleteKey(PREF_TURN_TOKEN);
        PlayerPrefs.DeleteKey(PREF_USERNAME);
        isPlaying = false;
        ShowHome(true);
    }

    // ── Leaderboard & QR ───────────────────────────────────────

    IEnumerator LeaderboardLoop()
    {
        while (true)
        {
            bool done = false;
            api.GetLeaderboard(10, "best_score",
                entries =>
                {
                    if (leaderboardText != null)
                    {
                        if (entries.Length == 0) leaderboardText.text = "No scores yet";
                        else
                        {
                            var sb = new System.Text.StringBuilder();
                            foreach (var e in entries) sb.AppendLine($"#{e.rank} {e.username}  {e.best_score}  W{e.wins} L{e.losses}");
                            leaderboardText.text = sb.ToString();
                        }
                    }
                    done = true;
                },
                e => { Debug.LogWarning("[LB] " + e); done = true; });
            yield return new WaitUntil(() => done);
            yield return new WaitForSeconds(leaderboardRefreshInterval);
        }
    }

    void RefreshQR()
    {
        if (qrImage == null) return;
        api.GetJoinQRTexture(tex =>
        {
            qrImage.texture = tex;
            qrImage.color = Color.white;
        }, e => Debug.LogWarning("[QR] " + e));
    }

    void UpdateHomeUI(QueueState s)
    {
        if (nowPlayingText != null)
            nowPlayingText.text = s.current == null ? "Ready to Play — Scan QR" : $"Now Playing: {s.current.display_name}";

        if (waitingText != null)
        {
            if (s.waiting == null || s.waiting.Length == 0) waitingText.text = "Waiting: empty";
            else
            {
                var sb = new System.Text.StringBuilder($"Waiting: {s.total_waiting}\n");
                foreach (var w in s.waiting) sb.AppendLine($"#{w.position} {w.username}");
                waitingText.text = sb.ToString();
            }
        }
    }

    void ShowHome(bool show)
    {
        if (homePanel != null) homePanel.SetActive(show);
        if (gamePanel != null) gamePanel.SetActive(!show);
    }

    void SetStatus(string msg)
    {
        if (statusText != null) statusText.text = msg;
        Debug.Log("[Flow] " + msg);
    }

    void OnDisable()
    {
        if (pollRoutine != null) StopCoroutine(pollRoutine);
    }

    // Untuk tombol manual / debug di Inspector
    [ContextMenu("Test Submit Win 500")]
    void TestSubmit() { if (isPlaying) SubmitScoreAndReturn(500, "win"); }
}
