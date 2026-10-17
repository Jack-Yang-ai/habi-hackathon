#pragma once
#include <ArduinoJson.h>
#include <cstring>

template <typename Payload>
bool captureAcknowledged(const Payload &payload, const char *expectedId) {
  if (!expectedId || !expectedId[0]) return false;
  // A durable ACK may also contain a large candidate meal; retain only IDs.
  StaticJsonDocument<128> filter;
  filter["capture_id"] = true; filter["capture"]["capture_id"] = true;
  StaticJsonDocument<384> reply;
  if (deserializeJson(reply, payload, DeserializationOption::Filter(filter))) return false;
  return std::strcmp(reply["capture_id"] | "", expectedId) == 0
    || std::strcmp(reply["capture"]["capture_id"] | "", expectedId) == 0;
}
