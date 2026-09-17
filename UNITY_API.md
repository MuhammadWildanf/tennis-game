# 🎾 Tennis Challenge — Dokumentasi API untuk Unity

> Server: Node.js + SQLite · Komunikasi: **HTTP REST saja** · Versi kontrak: 1.1.0
> Kontrak mesin (selalu sinkron dengan code): `GET /api/unity/info`

---

## 1. Konfigurasi

| Item | Nilai |
|---|---|
| Base URL | `http(s)://<DOMAIN-atau-IP-LAN>:port` — event: domain, mis. `https://tennis.event.com` (JANGAN `localhost`, HP tidak bisa akses) |
| Admin dashboard | `/admin.html` — terbuka di LAN tanpa key |
| Database | file lokal `tennis.db` (lihat log boot untuk path-nya) |

**Deploy domain + HTTPS** (disarankan): pasang reverse proxy (nginx/Caddy) terminasi TLS di depan Node. Syarat proxy: teruskan header `Host`, `X-Forwarded-Proto`, `X-Forwarded-Host` — server sudah `trust proxy`, jadi isi QR + `unity/info` otomatis ikut domain (mis. `https://tennis.event.com`).

Cek server hidup:

```
GET /api/status
→ { "ok": true, "version": "1.1.0", "server_time": "..." }
```

---

## 2. Konsep penting (baca dulu, 1 menit)

1. **Dua jenis token**
   - *Token HP* (dari signup) — umur panjang, dipakai HP untuk join/posisi/leaderboard.
   - *Token giliran* (dari `pick`/`claim-turn`) — **sekali pakai**: hangus otomatis begitu skor masuk. Submit kedua dengan token sama → `401`.
2. **Antrian milik server.** Unity tidak menentukan siapa main — Unity hanya polling `state` + `claim-turn`, server (via usher pick) yang memberi pemain berikut + tokennya.
3. **Pemain tidak pernah nunggu untuk scan.** Scan kapan saja (bahkan saat orang lain main) → dapat nomor. Yang nunggu hanya giliran mainnya.
4. **Usher-only, tanpa tombol START di HP.** Usher tap ▶ di `/queue` → Unity langsung mulai game.

---

## 3. Alur fix saat event (usher-driven)

> Semua daftar → antrian. **Staff pilih pemain di `/queue`.** Begitu staff pick, Unity ikut main. Unity TIDAK memanggil `next()`/`pick` — hanya polling + claim. **Pemain TIDAK tekan tombol apa pun — usher klik ▶ = game langsung mulai.**

```
[Unity idle]  QR statis → {BASE}/join  (+ polling state tiap 2 detik)
     │  pemain scan (kapan saja, berapa pun orang) → isi alias → dapat nomor
     ▼
[Staff di /queue]  tap ▶ pada pemain  →  jadi current (ready=1 otomatis)
     │
[Unity]  lihat current baru di state → POST /api/queue/claim-turn → simpan token (overwrite token lama!)
     │  tampil "Now playing: A" → LANGSUNG mulai game (jangan tunggu ready/START HP)
     ▼
[Game selesai]  POST /api/score (Bearer token giliran)  →  token hangus + station bebas
     │
[Staff]  tap ▶ pemain berikut … (atau Skip = FIFO)
```

### Loop Unity (pseudo-code — fix, tanpa next/pick, tanpa tunggu START)

```
loop tiap 2 detik:
  state = GET /api/queue/state
  tampilkan: now playing, waiting list, leaderboard (GET /api/leaderboard?limit=10)

  if state.current == null: tampilkan QR + "Scan to Play"
  elif state.current.username != username_diingat:
    claim = POST /api/queue/claim-turn   // idempotent, OVERWRITE token lama di PlayerPrefs
    username_diingat = claim.user.username
    MULAI GAME LANGSUNG dengan username_diingat   // JANGAN cek ready / tunggu START HP

habis game:
  POST /api/score { score, result: "win"|"loss" }   // Bearer token giliran
  // 401 di sini = skor sudah masuk (jangan resubmit), verifikasi via leaderboard
  username_diingat = null   // kembali polling, tunggu staff pick berikut
```

---

## 4. Referensi endpoint

### 4.1. Dipakai UNITY (final — 7 endpoint, usher-driven)

| # | Endpoint | Kapan |
|---|---|---|
| 1 | `GET /api/status` | boot: cek server hidup |
| 2 | `GET /qr/join.png` | tampilkan QR (via IP LAN/domain, refresh 5 mnt) |
| 3 | `GET /api/queue/state` | polling 2 detik: siapa main + antrian |
| 4 | `POST /api/queue/claim-turn` | current baru muncul → ambil token (idempotent; OVERWRITE token lama; 404 = belum ada yang main; 409 = giliran sudah selesai) → LANGSUNG mulai game |
| 5 | `GET /api/profile` | opsional: verifikasi token / best score |
| 6 | `POST /api/score` | game selesai (token hangus otomatis) |
| 7 | `GET /api/leaderboard?sort=best_score&limit=10` | layar leaderboard, refresh 15–30 detik |

**Yang JANGAN dipanggil Unity:** `POST /api/queue/next`, `POST /api/queue/pick` (itu kerjaan halaman staff `/queue`).

### 4.2. Giliran & antrian — detail respons

**Lihat status antrian** — polling tiap 2 detik:

```
GET /api/queue/state
→ {
    "current": { "username": "A", "display_name": "A",
                 "best_score": 120, "ready": 1, "turn_started_at": "..." } | null,
    "waiting": [ { "username": "B", "position": 2 }, ... ],
    "total_waiting": 1
  }
```

**Ambil token giliran** — sekali per giliran baru, simpan PlayerPrefs:

```
POST /api/queue/claim-turn
→ { "token": "uuid-…", "user": { "id": "…", "username": "A", "display_name": "A" } }
→ 404 { "error": "No one is playing right now" }
→ 409 { "error": "Turn is over …" }   // skor sudah masuk, tunggu pick berikut
```

**Kirim skor** — header wajib `Authorization: Bearer <token-giliran>`:

```
POST /api/score
Body: { "score": 500, "result": "win", "opponent": "AI" }
→ { "success": true, "match_id": "…" }
```

Aturan: `score` 0–99999 integer, `result` hanya `win`/`loss`. Sukses = token hangus + station bebas.

**Profil pemain** (verifikasi token / ambil best score):

```
GET /api/profile   (Bearer token apa saja)
→ { "username": "A", "best_score": 120, "total_matches": 3, "wins": 2, ... }
```

**Leaderboard** — untuk layar Unity, refresh 15–30 detik:

```
GET /api/leaderboard?sort=best_score&limit=10
→ [ { "rank": 1, "username": "A", "display_name": "A",
      "best_score": 500, "wins": 2, "losses": 1 }, ... ]
```

### 4.3. Dipakai HP pemain (untuk referensi, Unity tidak panggil)
| Endpoint | Fungsi |
|---|---|
| `POST /api/signup {username}` | daftar alias 2–12 char (A–Z, 0–9) → token HP |
| `POST /api/queue/join` | masuk antrian → `{status, position}` |
| `GET /api/queue/my-status` | posisi live (polling 3 detik di HP) |
| `POST /api/queue/leave` | keluar antrian |

### 4.4. Staff pick (usher pilih pemain — halaman `/queue`, tanpa key)

Semua daftar → masuk antrian. Staff tap ▶ pada siapa saja (bebas, tidak harus FIFO):

```
POST /api/queue/pick  Body: { "username": "B" }
→ { "current": { "token", "user" }, "waiting_count": 2 }

Diproteksi: kalau ada yang sedang main → 409 { need_force: true }.
Paksa ganti: { "username": "B", "force": true } (staff konfirmasi di dialog).
Pemain tidak di antrian → 409. Skip FIFO → POST /api/queue/next.
```

Dengan staff pick, Unity TIDAK perlu memanggil `next()` — cukup polling `state`.
QR statis `/join` boleh dipasang di mana saja (game, poster, pintu masuk) — semua masuk antrian yang sama.

### 4.5. QR & halaman web

| URL | Fungsi |
|---|---|
| `GET /qr/join.png` | **gambar QR** — request via IP LAN agar isinya URL LAN. Statis, tidak expired, boleh dicetak |
| `/join` | halaman HP: alias → nomor antrian → thanks + Play Again (usher yang mulai game) |
| `/queue` | halaman staff: Now Playing + antrian + tombol ▶/Skip/✕, auto-refresh |
| `/display` | **layar game versi browser**: QR besar + Now Playing + antrian + Top 5, auto-refresh. Buka fullscreen (F11) — Unity tidak perlu bikin UI QR sama sekali |
| `/` | halaman utama + leaderboard (auto-refresh 15 detik) |
| `/admin.html` | dashboard staff: stats, antrian live (+ tendang ✕), match, QR cetak |

---

## 5. Error & aturan retry

| Kode | Arti | Aksi Unity |
|---|---|---|
| `401` saat submit skor | token hangus = skor (kemungkinan) sudah masuk | JANGAN resubmit. Cek leaderboard, lalu kembali polling tunggu staff pick berikut (JANGAN panggil `next()`) |
| `409` | slot sudah dipakai / bukan giliran | tampilkan pesan, jangan retry buta |
| `400` | input salah (skor/result) | perbaiki value, cek validasi di §4.1 |
| Timeout > 5 detik | jaringan venue sibuk | retry request yang SAMA sekali, lalu verifikasi via leaderboard |

Interval yang disarankan: `state` 2 detik · leaderboard 10–30 detik · timeout request 5 detik.
Aturan token: score WAJIB pakai token giliran dari `claim-turn` terakhir (overwrite token lama tiap giliran baru). Kalau pakai token lama, score tercatat atas nama pemain sebelumnya.

---

## 6. Contoh C# (UnityWebRequest — usher-only)

```csharp
string rememberedUsername = null;
string turnToken = null;

// Loop polling tiap 2 detik
IEnumerator PollLoop() {
  while (true) {
    // 1. Lihat siapa yang di-pick usher
    UnityWebRequest req = UnityWebRequest.Get(BASE + "/api/queue/state");
    yield return req.SendWebRequest();
    var state = JsonUtility.FromJson<QueueState>(req.downloadHandler.text);

    if (state.current == null) {
      ShowQR(); // idle: tampilkan QR + "Scan to Play"
    } else if (state.current.username != rememberedUsername) {
      // 2. Usher pick baru → claim token → LANGSUNG mulai game
      UnityWebRequest claim = new UnityWebRequest(BASE + "/api/queue/claim-turn", "POST");
      claim.downloadHandler = new DownloadHandlerBuffer();
      yield return claim.SendWebRequest();
      var c = JsonUtility.FromJson<ClaimResponse>(claim.downloadHandler.text);
      turnToken = c.token; // OVERWRITE token lama!
      rememberedUsername = c.user.username;
      StartGame(rememberedUsername); // JANGAN tunggu ready / START HP
    }
    yield return new WaitForSeconds(2f);
  }
}

// 3. Kirim skor (token giliran) — tercatat atas nama picked player
IEnumerator SubmitScore(int score, string result) {
  string body = $"{{\"score\":{score},\"result\":\"{result}\",\"opponent\":\"AI\"}}";
  UnityWebRequest post = new UnityWebRequest(BASE + "/api/score", "POST");
  post.uploadHandler = new UploadHandlerRaw(System.Text.Encoding.UTF8.GetBytes(body));
  post.downloadHandler = new DownloadHandlerBuffer();
  post.SetRequestHeader("Content-Type", "application/json");
  post.SetRequestHeader("Authorization", "Bearer " + turnToken);
  yield return post.SendWebRequest();
  if (post.responseCode == 401) { /* skor sudah masuk → jangan resubmit, kembali polling */ }
  rememberedUsername = null; turnToken = null;
}
```

---

## 7. Checklist venue (H-1 & hari-H)

- [ ] Kunci static IP PC server · buka firewall inbound TCP 2000 · catat IP LAN
- [ ] `npm run reset-db` (server mati) → leaderboard bersih
- [ ] Tes scan 1–3 m · tes 2 HP barengan · cek `/admin` terbuka
- [ ] Hari-H: `npm start` → buka `/display` fullscreen + `/admin` di tab sebelah → `npm run backup-db` tiap istirahat
