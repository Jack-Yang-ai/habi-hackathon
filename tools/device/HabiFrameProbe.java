package com.withecho.device;

import android.content.Context;
import android.net.LocalServerSocket;
import android.os.Bundle;
import android.os.Looper;
import android.os.SystemClock;
import android.system.Os;
import android.system.OsConstants;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/** One static Habi frame, a bounded shell-only experiment. No settings writes or root. */
public final class HabiFrameProbe {
    private static final int UID = 2000;
    private static final String CLASS = "com.withecho.device.HabiFrameProbe";
    private static final String LEASE = "com.withecho.habi.frame.controller.v1";
    private static final String GUARD_LEASE = "com.withecho.habi.frame.guard.v1";
    private static final String FRAME_KEY = "stepos_back_screen_basic_frame";
    private static final long HARD_LIMIT_MS = 30000;
    private static final long PERSIST_SETTLE_MS = 6200;

    public static void main(String[] args) {
        try {
            if (android.os.Process.myUid() != UID) throw new SecurityException("requires-shell-uid-2000");
            if (args.length == 7 && args[0].equals("controller") && (args[6].equals("wake") || args[6].equals("no-wake"))) {
                controller(directory(args[1]), args[2], Integer.parseInt(args[3]),
                        Integer.parseInt(args[4]), args[5], args[6].equals("wake"));
            } else if (args.length == 3 && args[0].equals("guard") && args[2].matches("[0-9a-f-]{36}")) {
                guard(directory(args[1]), args[2]);
            } else throw new IllegalArgumentException("fixed-controller-or-guard-arguments-required");
            System.exit(0);
        } catch (Throwable failure) {
            System.out.println("HABI_FRAME_FAILED " + failure.getClass().getSimpleName() + ":" + safe(failure.getMessage()));
            System.exit(1);
        }
    }

    private static Path directory(String text) throws Exception {
        if (!text.matches("/data/local/tmp/habi-frame-[0-9a-f]{24}")) throw new SecurityException("invalid-run-directory");
        Path path = Paths.get(text);
        if (!Files.isDirectory(path) || !path.toRealPath().equals(path)
                || Os.lstat(text).st_uid != UID || (Os.lstat(text).st_mode & 077) != 0)
            throw new SecurityException("run-directory-owner-mode");
        return path;
    }

    private static void controller(Path dir, String scene, int frameIndex, int seconds, String expectedHash, boolean wake) throws Exception {
        if (!scene.matches("[a-z][a-z0-9_]{0,31}") || seconds != 8 || frameIndex < 0 || frameIndex > 31
                || !expectedHash.matches("[0-9a-f]{64}"))
            throw new IllegalArgumentException("only-validated-pattern-scenes-and-eight-seconds-supported");
        try (LocalServerSocket lease = new LocalServerSocket(LEASE)) {
            // A previous guard retains its lease while completing delayed-persistence cleanup.
            try (LocalServerSocket noPreviousGuard = new LocalServerSocket(GUARD_LEASE)) { }
            byte[] source = Files.readAllBytes(dir.resolve("habi.json"));
            if (!sha256(source).equals(expectedHash)) throw new SecurityException("pattern-source-hash");
            JSONObject pattern = new JSONObject(new String(source, StandardCharsets.UTF_8));
            JSONArray allHashes = validatePattern(pattern);
            JSONArray frames = pattern.getJSONObject("scenes").getJSONObject(scene).getJSONArray("frames");
            if (frameIndex >= frames.length()) throw new IllegalArgumentException("frame-index-out-of-range");
            int[] pixels = unpack(frames.getJSONObject(frameIndex).getJSONArray("rowBitmasks"));
            String frameHash = sha256(bytes(pixels));
            Screen screen = new Screen();
            Snapshot before = snapshot();
            if (!before.emptySlot()) throw new IllegalStateException("custom-slot-not-confirmed-empty");
            if (before.externalInteraction()) throw new IllegalStateException("external-active-interaction");
            String epoch = UUID.randomUUID().toString();
            long start = SystemClock.elapsedRealtime();
            JSONObject owner = new JSONObject().put("version", 1).put("epoch", epoch).put("uid", UID)
                    .put("parentPid", android.os.Process.myPid()).put("parentTicks", ticks(android.os.Process.myPid()))
                    .put("bootId", bootId()).put("createdElapsed", start).put("hardDeadlineElapsed", start + HARD_LIMIT_MS)
                    .put("patternId", pattern.getString("patternId")).put("sourceSha256", expectedHash).put("scene", scene)
                    .put("frameIndex", frameIndex).put("plannedSeconds", seconds).put("wakeRequested", wake)
                    .put("frameSha256", frameHash).put("allAllowedFrameHashes", allHashes)
                    .put("submittedFrameHashes", new JSONArray().put(frameHash)).put("baseline", before.json());
            atomic(dir, "owner.json", owner);
            heartbeat(dir, epoch);
            ProcessBuilder builder = new ProcessBuilder("/system/bin/app_process", "/system/bin", CLASS, "guard", dir.toString(), epoch);
            builder.environment().put("CLASSPATH", dir.resolve("probe.jar").toString());
            builder.redirectInput(new File("/dev/null")).redirectErrorStream(true).redirectOutput(dir.resolve("guard.log").toFile());
            java.lang.Process guard = builder.start();
            long readyUntil = SystemClock.elapsedRealtime() + 3000;
            for (;;) {
                if (!guard.isAlive() || SystemClock.elapsedRealtime() > readyUntil) throw new IllegalStateException("guard-not-ready");
                if (Files.exists(dir.resolve("guard.json"))) {
                    JSONObject ready = read(dir, "guard.json");
                    if (epoch.equals(ready.optString("epoch")) && alive(ready.getInt("pid"), ready.getString("ticks"), "guard", dir)) break;
                }
                Thread.sleep(50);
            }
            // Journal precedes the oneway Binder setter. Never emit another frame after this call.
            Snapshot lastCheck = snapshot();
            if (!lastCheck.emptySlot() || lastCheck.externalInteraction()) throw new IllegalStateException("slot-changed-before-submit");
            long submitted = SystemClock.elapsedRealtime();
            JSONObject journal = new JSONObject(owner.toString()).put("submittedElapsed", submitted)
                    .put("deadlineElapsed", Math.min(start + HARD_LIMIT_MS, submitted + seconds * 1000L))
                    .put("released", false).put("setterAttempted", true);
            atomic(dir, "journal.json", journal);
            screen.frame(pixels);
            if (wake) command("/system/bin/dumpsys", "display_ext", "back_screen", "wake");
            event(dir, "controller-submitted", new JSONObject().put("frameSha256", frameHash).put("scene", scene)
                    .put("physicalVisualConfirmed", false).put("binderOnewaySubmissionOnly", true));
            for (;;) {
                heartbeat(dir, epoch);
                Thread.sleep(500);
                // Guard stops this exact process before cleanup. A missing guard ends controller writes.
                if (!guard.isAlive()) throw new IllegalStateException("guard-ended");
            }
        }
    }

    private static void guard(Path dir, String epoch) throws Exception {
        try (LocalServerSocket lease = new LocalServerSocket(GUARD_LEASE)) {
            JSONObject owner = read(dir, "owner.json");
            verifyOwner(owner, epoch);
            int parent = owner.getInt("parentPid"); String parentTicks = owner.getString("parentTicks");
            long hard = owner.getLong("hardDeadlineElapsed");
            Screen screen = new Screen();
            atomic(dir, "guard.json", new JSONObject().put("epoch", epoch).put("pid", android.os.Process.myPid())
                    .put("ticks", ticks(android.os.Process.myPid())).put("ready", true));
            JSONObject journal = null;
            boolean frameAccepted = false, persistedMatched = false, appliedObserved = false;
            JSONObject lastObservation = null;
            String reason = "deadline";
            while (SystemClock.elapsedRealtime() < hard) {
                if (Files.exists(dir.resolve("journal.json"))) {
                    journal = read(dir, "journal.json"); verifyOwner(journal, epoch);
                    if (journal.getLong("deadlineElapsed") > hard) throw new SecurityException("journal-deadline");
                }
                if (!alive(parent, parentTicks, "controller", dir)) { reason = "parent-gone"; break; }
                JSONObject beat = read(dir, "heartbeat.json");
                if (!epoch.equals(beat.optString("epoch")) || SystemClock.elapsedRealtime() - beat.getLong("elapsed") > 2500) {
                    reason = "parent-heartbeat-stale"; break;
                }
                Snapshot state = snapshot();
                event(dir, "observe", state.json());
                lastObservation = state.json();
                if (journal != null) {
                    boolean ownHash = strings(journal.getJSONArray("submittedFrameHashes")).contains(state.storedHash);
                    frameAccepted |= state.custom && state.owner == UID;
                    persistedMatched |= ownHash;
                    appliedObserved |= state.custom && state.owner == UID && state.appliedText.equals("true");
                }
                if (journal != null && SystemClock.elapsedRealtime() >= journal.getLong("deadlineElapsed")) break;
                Thread.sleep(250);
            }
            stopOwnParent(parent, parentTicks, dir);
            if (journal == null && Files.exists(dir.resolve("journal.json"))) { journal = read(dir, "journal.json"); verifyOwner(journal, epoch); }
            if (journal == null) {
                atomic(dir, "result.json", new JSONObject().put("ok", false).put("reason", "no-frame-submitted")
                        .put("epoch", epoch).put("physicalVisualConfirmed", false));
                return;
            }
            Set<String> submittedHashes = strings(journal.getJSONArray("submittedFrameHashes"));
            long clearAt = -1, emptySince = -1; int clearCount = 0;
            boolean external = false, clean = false; String cleanup = "unverified";
            Snapshot finalState = null;
            while (SystemClock.elapsedRealtime() < hard) {
                Snapshot first = snapshot(); finalState = first;
                frameAccepted |= first.custom && first.owner == UID;
                persistedMatched |= submittedHashes.contains(first.storedHash);
                appliedObserved |= first.custom && first.owner == UID && first.appliedText.equals("true");
                event(dir, "cleanup-observe", first.json());
                if (!first.known()) { emptySince = -1; cleanup = "snapshot-unavailable"; Thread.sleep(250); continue; }
                if (first.foreignFrame(submittedHashes)) { external = true; cleanup = "external-frame-preserved"; break; }
                if (first.emptySlot()) {
                    if (emptySince < 0) emptySince = SystemClock.elapsedRealtime();
                    // A parent can disappear before its oneway Binder call arrives. Retain
                    // the guard through a full delayed-persistence window even if initially empty.
                    if (SystemClock.elapsedRealtime() - emptySince >= PERSIST_SETTLE_MS
                            && (clearAt < 0 || SystemClock.elapsedRealtime() - clearAt >= PERSIST_SETTLE_MS)) {
                        Thread.sleep(75);
                        Snapshot second = snapshot(); finalState = second;
                        if (second.emptySlot() && first.sameFrame(second)) {
                            clean = true; cleanup = clearCount == 0 ? "no-owned-frame-observed" : "cleared-and-persistence-rechecked"; break;
                        }
                        emptySince = -1;
                    }
                } else {
                    emptySince = -1;
                }
                if (first.mayClear(submittedHashes) && (clearAt < 0 || SystemClock.elapsedRealtime() - clearAt >= PERSIST_SETTLE_MS)) {
                    Thread.sleep(75);
                    Snapshot second = snapshot(); finalState = second;
                    // Null clears any owner on this firmware, hence both snapshots must agree.
                    if (!first.sameFrame(second) || !second.mayClear(submittedHashes)) { cleanup = "ownership-changed-during-check"; continue; }
                    screen.frame(null); clearAt = SystemClock.elapsedRealtime(); clearCount++;
                    event(dir, "clear-submitted", second.json());
                } else if (first.custom && first.owner == UID && first.storedHash.isEmpty()) {
                    cleanup = "waiting-for-persisted-frame-identity";
                }
                Thread.sleep(250);
            }
            journal.put("released", clean).put("cleanup", cleanup).put("externalChange", external).put("clearCount", clearCount);
            atomic(dir, "journal.json", journal);
            boolean success = frameAccepted && persistedMatched && clean;
            JSONObject result = new JSONObject().put("ok", success).put("testOverallSuccess", success)
                    .put("cleanupSucceeded", clean).put("frameAccepted", frameAccepted).put("persistedFrameMatched", persistedMatched)
                    .put("appliedCustomFrameObserved", appliedObserved).put("lastDisplayObservation", lastObservation)
                    .put("epoch", epoch).put("reason", reason)
                    .put("cleanup", cleanup).put("clearCount", clearCount).put("externalChange", external)
                    .put("plannedSeconds", 8).put("totalElapsedMs", SystemClock.elapsedRealtime() - owner.getLong("createdElapsed"))
                    .put("physicalVisualConfirmed", false).put("directSettingsWrites", false).put("vendorPersistsFrame", true)
                    .put("final", finalState == null ? JSONObject.NULL : finalState.json());
            atomic(dir, "result.json", result);
            System.out.println(result.toString());
        } catch (Throwable failure) {
            // Failure is recorded without guessing that a possibly external frame is ours.
            atomic(dir, "result.json", new JSONObject().put("ok", false).put("epoch", epoch)
                    .put("cleanup", "guard-failed-no-blind-clear").put("error", failure.getClass().getSimpleName())
                    .put("detail", safe(failure.getMessage())).put("physicalVisualConfirmed", false));
            throw failure;
        }
    }

    private static void verifyOwner(JSONObject owner, String epoch) throws Exception {
        long created = owner.getLong("createdElapsed"), hard = owner.getLong("hardDeadlineElapsed");
        if (!epoch.equals(owner.getString("epoch")) || owner.getInt("uid") != UID || !bootId().equals(owner.getString("bootId"))
                || created < 0 || hard != created + HARD_LIMIT_MS || created > SystemClock.elapsedRealtime()
                || !owner.getString("patternId").matches("[a-z][a-z0-9_-]{0,63}")) throw new SecurityException("journal-identity");
    }

    private static void stopOwnParent(int pid, String start, Path dir) throws Exception {
        if (!alive(pid, start, "controller", dir)) return;
        Os.kill(pid, OsConstants.SIGSTOP);
        if (alive(pid, start, "controller", dir)) Os.kill(pid, OsConstants.SIGKILL);
        long until = SystemClock.elapsedRealtime() + 1000;
        while (alive(pid, start, "controller", dir)) {
            if (SystemClock.elapsedRealtime() >= until) throw new IllegalStateException("own-parent-still-alive");
            Thread.sleep(25);
        }
    }

    static final class Snapshot {
        final String customText, appliedText, ownerText, agentOwnerText, agentState, animation, storedHash, power, policy;
        final boolean storedKnown, custom; final int owner;
        Snapshot(String dump, String stored, boolean storedKnown) {
            customText = value(dump, "appUsesCustomFrame"); appliedText = value(dump, "appliedCustomFrame");
            ownerText = value(dump, "appFrameOwner"); agentOwnerText = value(dump, "agentStateOwner");
            agentState = value(dump, "appAgentState"); animation = value(dump, "currentAnimInfo");
            power = value(dump, "power"); policy = value(dump, "policyAllowsOutput");
            this.storedKnown = storedKnown; custom = customText.equals("true"); owner = ownerUid(ownerText);
            storedHash = storedKnown ? storedHash(stored) : "invalid";
        }
        boolean known() { return (customText.equals("true") || customText.equals("false"))
                && (appliedText.equals("true") || appliedText.equals("false")) && !ownerText.isEmpty()
                && storedKnown && !storedHash.equals("invalid"); }
        boolean emptySlot() { return known() && !custom && appliedText.equals("false") && ownerText.equals("none") && storedHash.isEmpty(); }
        boolean externalInteraction() {
            Set<String> resident = new HashSet<>(Arrays.asList("idle", "idle_night", "idle_loafing", "fallback"));
            return agentState.isEmpty() || agentOwnerText.isEmpty() || animation.isEmpty()
                    || (ownerUid(agentOwnerText) != -1 && !resident.contains(agentState) && !animation.equals("null"));
        }
        boolean foreignFrame(Set<String> ours) {
            return known() && ((custom && owner != UID) || (owner >= 0 && owner != UID)
                    || (!storedHash.isEmpty() && !ours.contains(storedHash)));
        }
        boolean mayClear(Set<String> ours) {
            return known() && !storedHash.isEmpty() && ours.contains(storedHash)
                    && ((custom && owner == UID) || (!custom && ownerText.equals("none")));
        }
        boolean sameFrame(Snapshot other) { return known() && other.known() && customText.equals(other.customText)
                && ownerText.equals(other.ownerText) && storedHash.equals(other.storedHash); }
        JSONObject json() throws Exception { return new JSONObject().put("known", known()).put("custom", customText)
                .put("appliedCustomFrame", appliedText).put("frameOwner", ownerText).put("storedFrameSha256", storedHash)
                .put("agentState", agentState).put("agentOwner", agentOwnerText).put("power", power).put("policyAllowsOutput", policy)
                .put("elapsed", SystemClock.elapsedRealtime()); }
    }

    private static Snapshot snapshot() {
        String dump = "", stored = ""; boolean known = false;
        try { dump = command("/system/bin/dumpsys", "display_ext", "back_screen"); } catch (Exception ignored) { }
        try { stored = command("/system/bin/settings", "get", "system", FRAME_KEY).trim(); known = true; } catch (Exception ignored) { }
        return new Snapshot(dump, stored, known);
    }
    static int ownerUid(String text) {
        Matcher match = Pattern.compile("^uid=(\\d+)(?:\\s.*)?$").matcher(text);
        try { return match.matches() ? Integer.parseInt(match.group(1)) : -1; } catch (NumberFormatException invalid) { return -1; }
    }
    static String value(String text, String key) {
        Matcher match = Pattern.compile("(?m)^  " + Pattern.quote(key) + "=(.*)$").matcher(text);
        return match.find() ? match.group(1).trim() : "";
    }
    static String storedHash(String text) {
        if (text.isEmpty() || text.equals("null")) return "";
        try {
            byte[] data = java.util.Base64.getDecoder().decode(text);
            if (data.length != 391) return "invalid";
            return sha256(data);
        } catch (Exception invalid) { return "invalid"; }
    }
    private static JSONArray validatePattern(JSONObject p) throws Exception {
        if (p.getInt("schemaVersion") != 2 || !p.getString("brand").equals("Habi") || !p.getString("patternId").matches("[a-z][a-z0-9_-]{0,63}")
                || p.getInt("width") != 17 || p.getInt("height") != 23 || !p.getString("format").equals("row-bitmask-msb-left"))
            throw new SecurityException("pattern-schema");
        JSONObject scenes = p.getJSONObject("scenes");
        Set<String> names = new HashSet<>(); scenes.keys().forEachRemaining(names::add);
        if (names.isEmpty() || names.size() > 12) throw new SecurityException("pattern-scene-count");
        for (String name : names) if (!name.matches("[a-z][a-z0-9_]{0,31}")) throw new SecurityException("pattern-scene-name");
        JSONArray hashes = new JSONArray(); int count = 0;
        for (String name : names) {
            JSONObject scene = scenes.getJSONObject(name); JSONArray frames = scene.getJSONArray("frames");
            if (frames.length() < 1 || frames.length() > 32) throw new SecurityException("pattern-frame-count");
            for (int i = 0; i < frames.length(); i++) {
                JSONObject frame = frames.getJSONObject(i); long duration = frame.getLong("durationMs");
                if (duration < 120 || duration > 10000) throw new SecurityException("pattern-duration");
                JSONArray rows = frame.getJSONArray("rows"), masks = frame.getJSONArray("rowBitmasks");
                int[] pixels = unpack(masks);
                if (rows.length() != 23) throw new SecurityException("pattern-row-count");
                for (int y = 0; y < 23; y++) {
                    String row = rows.getString(y);
                    if (!row.matches("[.#]{17}")) throw new SecurityException("pattern-row");
                    for (int x = 0; x < 17; x++) if ((row.charAt(x) == '#') != (pixels[y * 17 + x] == 255))
                        throw new SecurityException("pattern-bit-order");
                }
                hashes.put(sha256(bytes(pixels))); count++;
            }
        }
        if (count > 128) throw new SecurityException("pattern-total-frame-count");
        return hashes;
    }
    private static int[] unpack(JSONArray masks) throws Exception {
        if (masks.length() != 23) throw new SecurityException("pattern-mask-count");
        int[] pixels = new int[391];
        for (int y = 0; y < 23; y++) {
            int row = masks.getInt(y); if (row < 0 || row >= (1 << 17)) throw new SecurityException("pattern-mask-range");
            for (int x = 0; x < 17; x++) pixels[y * 17 + x] = ((row >> (16 - x)) & 1) * 255;
        }
        return pixels;
    }
    private static byte[] bytes(int[] pixels) { byte[] result = new byte[pixels.length]; for (int i = 0; i < pixels.length; i++) result[i] = (byte) pixels[i]; return result; }
    static String sha256(byte[] data) throws Exception { StringBuilder result = new StringBuilder(); for (byte b : MessageDigest.getInstance("SHA-256").digest(data)) result.append(String.format("%02x", b & 255)); return result.toString(); }
    private static Set<String> strings(JSONArray values) throws Exception { Set<String> result = new HashSet<>(); for (int i = 0; i < values.length(); i++) result.add(values.getString(i)); return result; }
    private static String bootId() throws Exception { return new String(Files.readAllBytes(Paths.get("/proc/sys/kernel/random/boot_id")), StandardCharsets.UTF_8).trim(); }
    private static String ticks(int pid) throws Exception { String stat = new String(Files.readAllBytes(Paths.get("/proc/" + pid + "/stat")), StandardCharsets.UTF_8); return stat.substring(stat.lastIndexOf(')') + 2).trim().split("\\s+")[19]; }
    private static boolean alive(int pid, String start, String mode, Path dir) {
        try {
            if (pid < 2 || Os.lstat("/proc/" + pid).st_uid != UID || !ticks(pid).equals(start)) return false;
            String command = new String(Files.readAllBytes(Paths.get("/proc/" + pid + "/cmdline")), StandardCharsets.UTF_8).replace('\0', ' ');
            return command.contains(CLASS + " " + mode + " " + dir.toString() + " ");
        } catch (Exception gone) { return false; }
    }
    private static JSONObject read(Path dir, String name) throws Exception { return new JSONObject(new String(Files.readAllBytes(dir.resolve(name)), StandardCharsets.UTF_8)); }
    private static void heartbeat(Path dir, String epoch) throws Exception { atomic(dir, "heartbeat.json", new JSONObject().put("epoch", epoch).put("elapsed", SystemClock.elapsedRealtime())); }
    private static void atomic(Path dir, String name, JSONObject data) throws Exception {
        Path temp = dir.resolve(name + ".tmp-" + android.os.Process.myPid());
        try (FileOutputStream output = new FileOutputStream(temp.toFile())) { Os.chmod(temp.toString(), 0600); output.write(data.toString().getBytes(StandardCharsets.UTF_8)); output.getFD().sync(); }
        Os.rename(temp.toString(), dir.resolve(name).toString());
    }
    private static void event(Path dir, String type, JSONObject data) throws Exception {
        JSONObject record = new JSONObject().put("event", type).put("elapsed", SystemClock.elapsedRealtime()).put("data", data);
        String name = type.startsWith("controller") ? "controller-events.ndjson" : "guard-events.ndjson";
        try (FileOutputStream output = new FileOutputStream(dir.resolve(name).toFile(), true)) { output.write((record.toString() + "\n").getBytes(StandardCharsets.UTF_8)); }
    }
    private static String command(String... args) throws Exception {
        java.lang.Process process = new ProcessBuilder(args).redirectErrorStream(true).start();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        Thread reader = new Thread(() -> { try (InputStream input = process.getInputStream()) { byte[] buffer = new byte[4096]; int n; while ((n = input.read(buffer)) != -1) { if (bytes.size() + n > 131072) { process.destroyForcibly(); break; } bytes.write(buffer, 0, n); } } catch (Exception ignored) { } });
        reader.setDaemon(true); reader.start();
        if (!process.waitFor(1800, TimeUnit.MILLISECONDS)) { process.destroyForcibly(); throw new IllegalStateException("snapshot-command-timeout"); }
        reader.join(200);
        if (reader.isAlive() || process.exitValue() != 0) throw new IllegalStateException("snapshot-command-failed");
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }
    private static String safe(String value) { return value == null ? "" : value.replaceAll("[^A-Za-z0-9_.:-]", "_").substring(0, Math.min(180, value.length())); }
    private static final class Screen {
        final Object manager;
        Screen() throws Exception {
            if (Looper.myLooper() == null) Looper.prepareMainLooper();
            Class<?> type = Class.forName("android.app.ActivityThread"); Object thread = type.getMethod("systemMain").invoke(null);
            Context context = (Context) type.getMethod("getSystemContext").invoke(thread); manager = context.getSystemService("display_ext");
            if (manager == null) throw new IllegalStateException("vendor-manager-unavailable");
        }
        void frame(int[] pixels) throws Exception { manager.getClass().getMethod("setBackScreenFrame", int[].class, Bundle.class).invoke(manager, pixels, null); }
    }
}
