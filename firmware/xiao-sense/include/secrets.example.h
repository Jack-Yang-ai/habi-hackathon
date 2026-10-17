#pragma once
// Copy to secrets.h locally. Never commit Wi-Fi passwords or a device token.
#define ECHO_WIFI_SSID ""
#define ECHO_WIFI_PASSWORD ""
// The phone hotspot gateway, or the computer running the API on the same LAN.
// LAN transport is a development prototype; do not expose this HTTP port publicly.
#define ECHO_API_BASE "http://192.168.1.10:8787"
#define ECHO_DEVICE_TOKEN ""
