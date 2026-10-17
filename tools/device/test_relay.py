"""Guard regressions; synthetic status only, no phone or private data access."""
import argparse
import unittest
from unittest.mock import patch
from relay import Relay


class FakeRelay(Relay):
    def __init__(self, **overrides):
        super().__init__(argparse.Namespace(adb="unused", serial=None, keep_scene=False))
        self.commands = []
        self.snapshot = {"customFramePresent": False, "agentStateOwnerUid": None, "agentState": "idle", "agentAnimationActive": False}
        self.snapshot.update(overrides)

    def read_status(self):
        return self.snapshot

    def adb(self, *args):
        self.commands.append(args)
        return "accepted"


class OwnershipTests(unittest.TestCase):
    def test_existing_custom_frame_is_never_overwritten(self):
        relay = FakeRelay(customFramePresent=True)
        relay.apply("listening")
        self.assertEqual(relay.commands, [])

    def test_other_owner_active_interaction_is_preserved(self):
        relay = FakeRelay(agentStateOwnerUid="10134", agentState="speaking", agentAnimationActive=True)
        relay.apply("collecting")
        self.assertEqual(relay.commands, [])

    def test_exit_never_clears_new_custom_frame(self):
        relay = FakeRelay(customFramePresent=True, agentStateOwnerUid="2000", agentState="listening")
        relay.changed = True; relay.last_mapped = "listening"
        relay.close()
        self.assertEqual(relay.commands, [])

    def test_exit_does_not_reset_a_replaced_state(self):
        relay = FakeRelay(agentStateOwnerUid="10134", agentState="speaking")
        relay.changed = True; relay.last_mapped = "listening"
        relay.close()
        self.assertEqual(relay.commands, [])

    def test_repeated_poll_does_not_repeatedly_wake(self):
        relay = FakeRelay()
        with patch("relay.time.sleep"):
            relay.apply("listening")
            relay.apply("listening")
            relay.apply("collecting")
        wakes = [args for args in relay.commands if args[-1].endswith(" wake")]
        self.assertEqual(len(wakes), 1)

    def test_quiet_state_does_not_request_wake_or_power_off(self):
        relay = FakeRelay()
        with patch("relay.time.sleep"):
            relay.apply("resting")
        self.assertEqual(relay.commands, [("shell", "dumpsys display_ext back_screen state idle_night")])

    def test_finished_owner_does_not_block_a_later_interaction(self):
        relay = FakeRelay(agentStateOwnerUid="10134", agentState="wake_ai_key_click", agentAnimationActive=False)
        with patch("relay.time.sleep"):
            relay.apply("listening")
        self.assertTrue(any(args[-1].endswith(" state listening") for args in relay.commands))


if __name__ == "__main__":
    unittest.main()
