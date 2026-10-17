#pragma once
#include <algorithm>
#include <cstdint>
#include <string>

// Server windows are leases. Polling the same ID must never refill or extend one.
class CaptureWindowPolicy {
 public:
  static uint32_t budgetLimit(const std::string &phase) {
    return phase == "probe" ? 1 : phase == "followup" ? 2 : 0;
  }
  static bool validId(const std::string &id) {
    if(id.empty() || id.size()>128)return false;
    for(char c:id)if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='_'||c=='.'||c==':'||c=='-'))return false;
    return true;
  }
  static bool validIdentity(const std::string &id, const std::string &phase, const std::string &session) {
    return validId(id) && validId(session) && budgetLimit(phase);
  }
  bool update(const std::string &nextId, const std::string &nextPhase, const std::string &nextSession,
              uint64_t requestStartedMs, int64_t remainingTimeMs, uint32_t serverRemaining) {
    if (!validIdentity(nextId, nextPhase, nextSession) || remainingTimeMs <= 0 || !serverRemaining) { clear(); return false; }
    // A phase gets a fresh ID; a repeated ID cannot change its grouping or budget class.
    if (nextId == id && (nextPhase != phase || nextSession != sessionId)) { clear(); return false; }
    const uint64_t deadline = requestStartedMs + static_cast<uint64_t>(std::min<int64_t>(remainingTimeMs, 60000));
    const uint32_t budget = std::min<uint32_t>(serverRemaining, budgetLimit(nextPhase));
    const bool changed = nextId != id;
    if (changed) { id = nextId; phase = nextPhase; sessionId = nextSession; expiresAtMs = deadline; remaining = budget; }
    else { expiresAtMs = std::min(expiresAtMs, deadline); remaining = std::min(remaining, budget); }
    return changed;
  }
  bool allowed(uint64_t nowMs) const { return remaining > 0 && nowMs < expiresAtMs; }
  void consume() { if (remaining) --remaining; }
  void clear() { remaining = 0; expiresAtMs = 0; } // retain ID to reject a stale refill
  std::string id;
  std::string phase;
  std::string sessionId;
  uint64_t expiresAtMs = 0;
  uint32_t remaining = 0;
};
