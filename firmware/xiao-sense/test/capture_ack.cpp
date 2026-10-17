#include "CaptureAck.h"
#include <cassert>
#include <string>

int main() {
  const std::string id(128,'x');
  const std::string large = "{\"capture_id\":\""+id+"\",\"capture\":{\"capture_id\":\""+id
    +"\"},\"meal\":{\"unrelated_large_field\":\""+std::string(50000,'m')+"\"}}";
  assert(captureAcknowledged(large,id.c_str()));
  assert(captureAcknowledged(std::string("{\"capture\":{\"capture_id\":\"fixture\"}}"),"fixture"));
  assert(!captureAcknowledged(large,"different-id"));
  assert(!captureAcknowledged(std::string("{\"ok\":true}"),"fixture"));
  assert(!captureAcknowledged(std::string("{invalid-json"),"fixture"));
  assert(!captureAcknowledged(large,nullptr));
}
