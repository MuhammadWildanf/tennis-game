using System;

// API MODELS - data transfer untuk TennisApiClient (JSON <-> C#)
// Semua model sinkron dengan server.js + UNITY_API.md
// JsonUtility butuh [Serializable] dan field public

[Serializable]
public class StatusResponse
{
    public bool ok;
    public string version;
    public string server_time;
}

[Serializable]
public class UnityInfoResponse
{
    public string version;
    public string http_base;
    public string recommended_flow;
    public string[] unity_uses_only_these;
}

[Serializable]
public class UserInfo
{
    public string id;
    public string username;
    public string display_name;
}

[Serializable]
public class CurrentPlayer
{
    public string username;
    public string display_name;
    public int best_score;
    public string created_at;
    public string turn_started_at;
    public string ready_at;
    public int ready; // 1 = ready (usher auto-ready)
}

[Serializable]
public class WaitingPlayer
{
    public int position;
    public string username;
    public string display_name;
    public string created_at;
}

[Serializable]
public class QueueState
{
    public CurrentPlayer current; // null jika idle
    public WaitingPlayer[] waiting;
    public int total_waiting;
    public string display_mode; // "game" | "leaderboard" | "howtoplay" — dari admin
}

[Serializable]
public class ClaimResponse
{
    public string token;
    public UserInfo user;
}

[Serializable]
public class ScoreResponse
{
    public bool success;
    public string match_id;
}

[Serializable]
public class ProfileResponse
{
    public string id;
    public string username;
    public string display_name;
    public int total_matches;
    public int wins;
    public int losses;
    public int total_score;
    public int best_score;
    public string created_at;
    public string last_played;
}

[Serializable]
public class LeaderboardEntry
{
    public int rank;
    public string id;
    public string username;
    public string display_name;
    public int total_matches;
    public int wins;
    public int losses;
    public int total_score;
    public int best_score;
    public float win_rate;
}

// Wrapper untuk array top-level (JsonUtility tidak bisa parse array mentah)
[Serializable]
public class LeaderboardWrapper
{
    public LeaderboardEntry[] items;
}

[Serializable]
public class ErrorResponse
{
    public string error;
    public string playing;
    public bool need_force;
}

[Serializable]
public class DisplayModeResponse
{
    public string mode; // "game" | "leaderboard" | "howtoplay"
}

[Serializable]
public class HomeHeartbeatResponse
{
    public bool success;
    public bool at_home;
    public bool unity_home;
    public string server_time;
}
