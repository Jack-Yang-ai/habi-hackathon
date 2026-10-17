package com.withecho.companion;

import java.util.Collections;
import java.util.Set;

/** Host checks of the actual native ownership policy; no phone access. */
public final class RearFrameOwnershipFixture {
    private static int checks;
    private static void check(boolean value) { checks++; if(!value)throw new AssertionError("ownership check "+checks); }
    private static String dump(String custom,String owner,String agent,String os) {
        return "  appUsesCustomFrame="+custom+"\n  appliedCustomFrame="+custom+"\n  appFrameOwner="+owner
            +"\n  appAgentState="+agent+"\n  agentStateOwner=uid=10134\n  currentAnimInfo="+(agent.equals("idle")?"null":"active")
            +"\n  signalEffectiveOsState="+os+"\n  power=on\n  policyAllowsOutput=true\n";
    }
    public static void main(String[] args) {
        Set<String> own=Collections.singleton("own");
        RearFrameOwnership empty=new RearFrameOwnership(dump("false","none","idle","none"),"");
        check(empty.empty());check(!empty.ours(10109,own));check(!empty.externalInteraction());
        RearFrameOwnership ours=new RearFrameOwnership(dump("true","uid=10109","idle","none"),"own");
        check(ours.ours(10109,own));check(ours.activeOurs(10109));check(!ours.foreign(10109,own));
        check(!new RearFrameOwnership(dump("true","uid=2000","idle","none"),"own").ours(10109,own));
        check(new RearFrameOwnership(dump("true","uid=2000","idle","none"),"own").foreign(10109,own));
        check(new RearFrameOwnership(dump("true","uid=10109","idle","none"),"foreign").foreign(10109,own));
        check(!new RearFrameOwnership(dump("true","uid=10109","idle","none"),"").ours(10109,own));
        check(!new RearFrameOwnership("", "own").known());
        check(!new RearFrameOwnership(dump("true","uid=10109","idle","none"),"invalid").known());
        check(new RearFrameOwnership(dump("false","none","listening","none"),"").externalInteraction());
        check(new RearFrameOwnership(dump("false","none","idle","incoming_call"),"").externalInteraction());
        check(!ours.same(new RearFrameOwnership(dump("true","uid=10109","idle","none"),"other")));
        check(ours.same(new RearFrameOwnership(dump("true","uid=10109","idle","none"),"own")));
        check(new RearFrameOwnership(dump("false","none","idle","none"),"own").ours(10109,own));
        check(new RearFrameOwnership(dump("false","uid=2000","idle","none"),"own").foreign(10109,own));
        check(new RearFrameOwnership(dump("false","none","idle","none").replace("  signalEffectiveOsState=none\n", ""),"").externalInteraction());
        String stale=dump("false","none","idle","none").replace("appliedCustomFrame=false","appliedCustomFrame=true");
        check(!new RearFrameOwnership(stale, "").empty());
        String gated=stale.replace("power=on","power=off").replace("policyAllowsOutput=true","policyAllowsOutput=false");
        check(new RearFrameOwnership(gated, "").empty());
        check(!new RearFrameOwnership(gated, "own").empty());
        check(!new RearFrameOwnership(gated.replace("  power=off\n", ""), "").empty());
        System.out.println("Native rear ownership: "+checks+" checks passed.");
    }
}
