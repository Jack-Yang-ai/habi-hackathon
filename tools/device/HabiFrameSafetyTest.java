package com.withecho.device;

import java.util.Arrays;
import java.util.Collections;
import java.util.Set;

/** Host-only synthetic ownership tests: no Android process or phone access. */
public final class HabiFrameSafetyTest {
    private static int checks = 0;
    private static void check(boolean condition, String label) {
        checks++;
        if (!condition) throw new AssertionError(label);
    }
    private static String dump(boolean custom, String owner, String agent, String agentOwner, String animation) {
        return "BackScreen\n  appUsesCustomFrame=" + custom + "\n  appliedCustomFrame=" + custom
                + "\n  appFrameOwner=" + owner + "\n  agentStateOwner=" + agentOwner + "\n  appAgentState=" + agent
                + "\n  currentAnimInfo=" + animation + "\n  power=on\n  policyAllowsOutput=true\n";
    }
    public static void main(String[] args) throws Exception {
        byte[] own = new byte[391], foreign = new byte[391];
        Arrays.fill(own, (byte) 255); foreign[3] = 255 - 256;
        String a = java.util.Base64.getEncoder().encodeToString(own);
        String b = java.util.Base64.getEncoder().encodeToString(foreign);
        Set<String> hashes = Collections.singleton(HabiFrameProbe.sha256(own));
        HabiFrameProbe.Snapshot empty = new HabiFrameProbe.Snapshot(dump(false, "none", "idle", "none", "null"), "null", true);
        check(empty.emptySlot(), "empty verified slot is eligible");
        check(!empty.externalInteraction(), "idle with no animation is quiet");
        check(!empty.mayClear(hashes), "empty slot is never blindly cleared");
        HabiFrameProbe.Snapshot ours = new HabiFrameProbe.Snapshot(dump(true, "uid=2000", "idle", "none", "null"), a, true);
        check(ours.mayClear(hashes), "matching UID and exact persisted hash may clear");
        check(!ours.foreignFrame(hashes), "ours is identified");
        check(ours.sameFrame(new HabiFrameProbe.Snapshot(dump(true, "uid=2000", "idle", "none", "null"), a, true)), "stable double read");
        HabiFrameProbe.Snapshot foreignUid = new HabiFrameProbe.Snapshot(dump(true, "uid=10134", "idle", "none", "null"), a, true);
        check(!foreignUid.mayClear(hashes) && foreignUid.foreignFrame(hashes), "external UID wins even when bytes match");
        HabiFrameProbe.Snapshot foreignBytes = new HabiFrameProbe.Snapshot(dump(true, "uid=2000", "idle", "none", "null"), b, true);
        check(!foreignBytes.mayClear(hashes) && foreignBytes.foreignFrame(hashes), "same shell UID with external bytes is preserved");
        check(!ours.sameFrame(foreignBytes), "new shell frame changes double-read identity");
        HabiFrameProbe.Snapshot unpersisted = new HabiFrameProbe.Snapshot(dump(true, "uid=2000", "idle", "none", "null"), "null", true);
        check(!unpersisted.mayClear(hashes), "UID alone never authorizes clear before persistence");
        HabiFrameProbe.Snapshot stale = new HabiFrameProbe.Snapshot(dump(false, "none", "idle", "none", "null"), a, true);
        check(stale.mayClear(hashes), "owned persisted residue can be cleared with empty active slot");
        check(!new HabiFrameProbe.Snapshot("", a, true).mayClear(hashes), "missing dump fails closed");
        check(!new HabiFrameProbe.Snapshot(dump(true, "uid=2000", "idle", "none", "null"), "AA==", true).known(), "wrong frame length fails closed");
        check(!new HabiFrameProbe.Snapshot(dump(true, "uid=2000", "idle", "none", "null"), a, false).mayClear(hashes), "failed settings read fails closed");
        check(new HabiFrameProbe.Snapshot(dump(false, "none", "listening", "uid=2000", "BackScreenAnimationInfo{x}"), "null", true).externalInteraction(), "external shell interaction is preserved too");
        check(!new HabiFrameProbe.Snapshot(dump(false, "none", "listening", "uid=10134", "null"), "null", true).externalInteraction(), "finished interaction does not lock slot forever");
        check(HabiFrameProbe.ownerUid("uid=2000") == 2000 && HabiFrameProbe.ownerUid("xuid=2000") == -1, "owner parser is anchored");
        System.out.println("Habi frame safety: " + checks + " synthetic host checks passed.");
    }
}
