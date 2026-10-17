#include "CaptureWindowPolicy.h"
#include <cassert>

int main() {
  CaptureWindowPolicy window;
  assert(!window.allowed(100));
  assert(window.update("probe-a", "probe", "candidate-a", 1000, 45000, 99));
  assert(window.remaining == 1 && window.phase == "probe" && window.sessionId == "candidate-a");
  window.consume();
  assert(!window.allowed(1001)); // first image is the only probe exposure
  assert(!window.update("probe-a", "probe", "candidate-a", 2000, 45000, 1));
  assert(!window.allowed(2000) && window.expiresAtMs == 46000); // no refill or extension

  assert(window.update("followup-a", "followup", "candidate-a", 5000, 45000, 99));
  assert(window.remaining == 2 && window.sessionId == "candidate-a"); // stable grouping, fresh phase ID
  window.consume();
  window.update("followup-a", "followup", "candidate-a", 6000, 45000, 2);
  assert(window.remaining == 1 && window.expiresAtMs == 50000);
  window.consume();
  assert(!window.allowed(6001)); // a phase never creates its own next window
  window.update("followup-a", "followup", "candidate-a", 7000, 45000, 2);
  assert(!window.allowed(7000));

  assert(window.update("followup-b", "followup", "candidate-b", 10000, 45000, 1));
  assert(window.remaining == 1); // obey a smaller explicit server budget
  assert(window.allowed(54999) && !window.allowed(55000)); // offline expiry
  window.clear();
  window.update("followup-b", "followup", "candidate-b", 56000, 45000, 2);
  assert(!window.allowed(56000));

  assert(window.update("probe-c", "probe", "candidate-c", 60000, 90000, 5));
  assert(window.remaining == 1 && window.expiresAtMs == 120000); // bounded lease and probe budget
  assert(!window.update("probe-c", "followup", "candidate-c", 61000, 45000, 2));
  assert(!window.allowed(61000)); // changing phase needs a fresh ID
  assert(window.update("followup-c", "followup", "candidate-c", 62000, 45000, 2));
  assert(!window.update("followup-c", "followup", "other-candidate", 63000, 45000, 2));
  assert(!window.allowed(63000)); // a repeated ID cannot regroup photos

  assert(!window.update("bad", "unknown", "candidate-d", 70000, 45000, 1));
  assert(!window.update("bad", "probe", "", 70000, 45000, 1));
  assert(!window.update("bad", "probe", "candidate-d", 70000, 0, 1));
  assert(!window.update("bad", "probe", "candidate-d", 70000, 45000, 0));
  assert(!window.update("bad/id", "probe", "candidate-d", 70000, 45000, 1));
  assert(!window.update("bad", "probe", std::string(129,'s'), 70000, 45000, 1));
  assert(!window.allowed(70000));
}
