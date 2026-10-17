package com.withecho.companion;

import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Exact identity checks shared by frame submission and delayed cleanup. No device access. */
final class RearFrameOwnership {
    final String custom, applied, owner, hash, agent, agentOwner, animation, osState, power, policy;
    RearFrameOwnership(String dump, String hash) {
        custom=value(dump,"appUsesCustomFrame"); applied=value(dump,"appliedCustomFrame"); owner=value(dump,"appFrameOwner");
        this.hash=hash; agent=value(dump,"appAgentState"); agentOwner=value(dump,"agentStateOwner");
        animation=value(dump,"currentAnimInfo"); osState=value(dump,"signalEffectiveOsState");
        power=value(dump,"power"); policy=value(dump,"policyAllowsOutput");
    }
    boolean known() { return (custom.equals("true")||custom.equals("false")) && (applied.equals("true")||applied.equals("false")) && !owner.isEmpty() && !hash.equals("invalid"); }
    boolean empty() {
        // Firmware retains the last applied flag while its physical output is gated off.
        // Only accept that stale flag when the live and persisted slots are both empty,
        // and power plus policy independently confirm no physical output.
        boolean noOutput = applied.equals("false") || (power.equals("off") && policy.equals("false"));
        return known() && custom.equals("false") && noOutput && owner.equals("none") && hash.isEmpty();
    }
    boolean ours(int uid, Set<String> hashes) { return known() && !hash.isEmpty() && hashes.contains(hash) && ((custom.equals("true")&&uid(owner)==uid)||(custom.equals("false")&&owner.equals("none"))); }
    boolean activeOurs(int uid) { return known() && custom.equals("true") && uid(owner)==uid; }
    boolean foreign(int uid, Set<String> hashes) { return known() && ((custom.equals("true")&&uid(owner)!=uid)||(uid(owner)>=0&&uid(owner)!=uid)||(!hash.isEmpty()&&!hashes.contains(hash))); }
    boolean externalInteraction() {
        boolean resident=agent.equals("idle")||agent.equals("idle_night")||agent.equals("idle_loafing")||agent.equals("fallback");
        return agent.isEmpty()||agentOwner.isEmpty()||animation.isEmpty()||osState.isEmpty()||(!resident&&uid(agentOwner)>=0&&!animation.equals("null"))||!osState.equals("none");
    }
    boolean same(RearFrameOwnership other) { return known()&&other.known()&&custom.equals(other.custom)&&owner.equals(other.owner)&&hash.equals(other.hash); }
    static String value(String dump,String key) { Matcher m=Pattern.compile("(?m)^  "+Pattern.quote(key)+"=(.*)$").matcher(dump); return m.find()?m.group(1).trim():""; }
    static int uid(String text) { Matcher m=Pattern.compile("^uid=(\\d+)(?:\\s.*)?$").matcher(text); try { return m.matches()?Integer.parseInt(m.group(1)):-1; }catch(NumberFormatException e){return -1;} }
}
