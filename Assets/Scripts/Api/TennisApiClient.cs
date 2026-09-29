using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

/// <summary>
/// API CLIENT - khusus consume HTTP ke https://tennis-challenge.imajiwa.id
/// Cover 8 endpoint Unity: status, qr, state, claim-turn, score, leaderboard, profile, unity/info.
/// Jangan panggil /queue/next atau /queue/pick dari sini (tugas halaman usher /queue).
/// Dipakai oleh TennisSessionController.
/// </summary>
public class TennisApiClient : MonoBehaviour
{
    public static TennisApiClient Instance { get; private set; }

    [Header("Config")]
    [Tooltip("JANGAN pakai localhost untuk device lain. Pakai IP LAN PC server atau domain event.")]
    public string baseUrl = "https://tennis-challenge.imajiwa.id/";

    [Tooltip("Timeout per request (detik). Venue ramai -> 5 detik disarankan.")]
    public int timeoutSeconds = 5;

    string Base => baseUrl.TrimEnd('/');

    void Awake()
    {
        if (Instance != null && Instance != this) { Destroy(gameObject); return; }
        Instance = this;
        DontDestroyOnLoad(gameObject);
    }

    // ── Public API ─────────────────────────────────────────────

    public Coroutine CheckStatus(Action<StatusResponse> onSuccess, Action<string> onError)
        => StartCoroutine(GetJson("/api/status", onSuccess, onError));

    public Coroutine GetQueueState(Action<QueueState> onSuccess, Action<string> onError)
        => StartCoroutine(GetJson("/api/queue/state", onSuccess, onError));

    /// <summary>
    /// Mode layar dari admin: "game" (normal), "leaderboard" / "howtoplay" (takeover + READY dikunci).
    /// Poll tiap 2-3 detik, atau baca state.display_mode sekalian.
    /// </summary>
    public Coroutine GetDisplayMode(Action<DisplayModeResponse> onSuccess, Action<string> onError)
        => StartCoroutine(GetJson("/api/display/mode", onSuccess, onError));

    /// <summary>
    /// Lapor ke server: "saya di HOME". WAJIB tiap ~2 detik selama layar home tampil
    /// (kirim false saat masuk game / takeover). Tanpa heartbeat fresh, server KUNCI semua READY.
    /// </summary>
    public Coroutine ReportHome(bool atHome, Action<HomeHeartbeatResponse> onSuccess, Action<string> onError)
    {
        string body = "{\"at_home\":" + (atHome ? "true" : "false") + "}";
        return StartCoroutine(PostJson("/api/unity/home", body, null, onSuccess, onError));
    }

    /// <summary>
    /// Ambil token giliran. Idempotent: panggil tiap ada current baru, overwrite token lama.
    /// 404 = belum ada yang main, 409 = turn sudah selesai (skor sudah masuk).
    /// </summary>
    public Coroutine ClaimTurn(Action<ClaimResponse> onSuccess, Action<long, string> onError)
        => StartCoroutine(PostNoBody("/api/queue/claim-turn", onSuccess, onError));

    public Coroutine SubmitScore(int score, string result, string opponent, string turnToken,
        Action<ScoreResponse> onSuccess, Action<long, string> onError)
    {
        var body = JsonUtility.ToJson(new ScorePayload { score = score, result = result, opponent = opponent });
        // validasi lokal biar tidak kena 400
        if (score < 0 || score > 99999) { onError?.Invoke(400, "Score must be 0-99999"); return null; }
        if (result != "win" && result != "loss") { onError?.Invoke(400, "Result must be win/loss"); return null; }
        return StartCoroutine(PostJson("/api/score", body, turnToken, onSuccess, onError));
    }

    public Coroutine GetProfile(string token, Action<ProfileResponse> onSuccess, Action<long, string> onError)
        => StartCoroutine(GetJsonAuth("/api/profile", token, onSuccess, onError));

    public Coroutine GetLeaderboard(int limit, string sort, Action<LeaderboardEntry[]> onSuccess, Action<string> onError)
    {
        limit = Mathf.Clamp(limit, 1, 50);
        if (string.IsNullOrEmpty(sort)) sort = "best_score";
        return StartCoroutine(GetLeaderboardInternal($"/api/leaderboard?sort={sort}&limit={limit}", onSuccess, onError));
    }

    /// <summary>Download QR sebagai Texture. Minta via IP LAN/domain agar isinya URL LAN yang benar.</summary>
    public Coroutine GetJoinQRTexture(Action<Texture2D> onSuccess, Action<string> onError)
        => StartCoroutine(GetTexture("/qr/join.png", onSuccess, onError));

    public Coroutine GetUnityInfo(Action<UnityInfoResponse> onSuccess, Action<string> onError)
        => StartCoroutine(GetJson("/api/unity/info", onSuccess, onError));

    // ── Internals ──────────────────────────────────────────────

    [Serializable] class ScorePayload { public int score; public string result; public string opponent; }

    IEnumerator GetJson<T>(string path, Action<T> onSuccess, Action<string> onError)
    {
        string url = Base + path;
        using (var req = UnityWebRequest.Get(url))
        {
            req.timeout = timeoutSeconds;
            yield return req.SendWebRequest();
            if (IsSuccess(req)) onSuccess?.Invoke(JsonUtility.FromJson<T>(req.downloadHandler.text));
            else onError?.Invoke(FormatError(req));
        }
    }

    IEnumerator GetJsonAuth<T>(string path, string token, Action<T> onSuccess, Action<long, string> onError)
    {
        string url = Base + path;
        using (var req = UnityWebRequest.Get(url))
        {
            req.timeout = timeoutSeconds;
            req.SetRequestHeader("Authorization", "Bearer " + token);
            yield return req.SendWebRequest();
            if (IsSuccess(req)) onSuccess?.Invoke(JsonUtility.FromJson<T>(req.downloadHandler.text));
            else onError?.Invoke(req.responseCode, FormatError(req));
        }
    }

    IEnumerator PostNoBody<T>(string path, Action<T> onSuccess, Action<long, string> onError)
    {
        string url = Base + path;
        using (var req = new UnityWebRequest(url, "POST"))
        {
            req.downloadHandler = new DownloadHandlerBuffer();
            req.timeout = timeoutSeconds;
            req.SetRequestHeader("Content-Type", "application/json");
            yield return req.SendWebRequest();
            if (IsSuccess(req)) onSuccess?.Invoke(JsonUtility.FromJson<T>(req.downloadHandler.text));
            else onError?.Invoke(req.responseCode, FormatError(req));
        }
    }

    IEnumerator PostJson<T>(string path, string jsonBody, string bearerToken, Action<T> onSuccess, Action<long, string> onError)
    {
        string url = Base + path;
        byte[] body = Encoding.UTF8.GetBytes(jsonBody);
        using (var req = new UnityWebRequest(url, "POST"))
        {
            req.uploadHandler = new UploadHandlerRaw(body);
            req.downloadHandler = new DownloadHandlerBuffer();
            req.timeout = timeoutSeconds;
            req.SetRequestHeader("Content-Type", "application/json");
            if (!string.IsNullOrEmpty(bearerToken))
                req.SetRequestHeader("Authorization", "Bearer " + bearerToken);
            yield return req.SendWebRequest();
            if (IsSuccess(req)) onSuccess?.Invoke(JsonUtility.FromJson<T>(req.downloadHandler.text));
            else onError?.Invoke(req.responseCode, FormatError(req));
        }
    }

    IEnumerator GetLeaderboardInternal(string path, Action<LeaderboardEntry[]> onSuccess, Action<string> onError)
    {
        string url = Base + path;
        using (var req = UnityWebRequest.Get(url))
        {
            req.timeout = timeoutSeconds;
            yield return req.SendWebRequest();
            if (!IsSuccess(req)) { onError?.Invoke(FormatError(req)); yield break; }
            // Server kirim array mentah: [ {...}, ... ] -> bungkus agar JsonUtility bisa parse
            string wrapped = "{\"items\":" + req.downloadHandler.text + "}";
            var w = JsonUtility.FromJson<LeaderboardWrapper>(wrapped);
            onSuccess?.Invoke(w.items ?? new LeaderboardEntry[0]);
        }
    }

    IEnumerator GetTexture(string path, Action<Texture2D> onSuccess, Action<string> onError)
    {
        string url = Base + path;
        using (var req = UnityWebRequestTexture.GetTexture(url))
        {
            req.timeout = timeoutSeconds;
            yield return req.SendWebRequest();
            if (IsSuccess(req)) onSuccess?.Invoke(DownloadHandlerTexture.GetContent(req));
            else onError?.Invoke(FormatError(req));
        }
    }

    static bool IsSuccess(UnityWebRequest req)
        => req.result == UnityWebRequest.Result.Success && req.responseCode >= 200 && req.responseCode < 300;

    static string FormatError(UnityWebRequest req)
    {
        string body = req.downloadHandler?.text;
        if (!string.IsNullOrEmpty(body))
        {
            try { var e = JsonUtility.FromJson<ErrorResponse>(body); if (!string.IsNullOrEmpty(e.error)) return $"{(int)req.responseCode} {e.error}"; } catch { }
            return $"{(int)req.responseCode} {body}";
        }
        return $"{req.error} (HTTP {(int)req.responseCode})";
    }
}
