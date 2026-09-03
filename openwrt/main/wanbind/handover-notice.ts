/**
 * What the two pages say about records this module is still holding.
 *
 * Split from `handover.ts` next door because the two are different kinds of
 * thing and the split keeps them honest: that file offers records to the router
 * and this one writes the sentence about the ones it could not. Nothing here
 * reads or calls anything - it is handed an outcome and turns it into a line
 * somebody can act on.
 *
 * The two arguments are both load-bearing. `kind` decides which half's page is
 * asking, and asking for the wrong one is how the instance half came to print
 * the one-to-one count and say nothing at all about instances. `sweeping` on
 * the outcome decides what may be claimed about the rules: on a router with no
 * bm-wanbind they are standing untouched, and on one running a release this
 * module cannot drive they are being removed by it.
 */
import type { HandoverKind, HandoverOutcome } from './handover'


const NOUN: Record<HandoverKind, { one: string; many: string }> = {
  instance: { one: 'binding instance', many: 'binding instances' },
  binding: { one: 'one-to-one binding', many: 'one-to-one bindings' }
}

/**
 * What has stopped happening, per half, on a router with no daemon to hand
 * these to.
 *
 * Stated as what is no longer maintained rather than as what the rules are
 * doing, because the rules are still standing and still steering traffic: the
 * failure is that nothing reacts to a change any more, and a sentence that said
 * "these are not working" about addresses that are working perfectly well would
 * send somebody hunting for a fault that is not there.
 */
const UNMAINTAINED: Record<HandoverKind, string> = {
  instance:
    'a device that joins one of those LANs is given no WAN of its own, and a WAN that fails is not routed around',
  binding:
    'a device that picks up a different address is not followed to it, and a WAN that fails is not routed around'
}

/**
 * The sentence one half's page carries beneath its table, or empty.
 *
 * Kept out of `lastError` by the caller for the reason the snapshot's own
 * `notice` exists: neither of these is a call that failed, and a page whose
 * error panel reported them would be blaming a router that is answering
 * perfectly.
 */
export function handoverNotice(outcome: HandoverOutcome, kind: HandoverKind): string {
  const noun = NOUN[kind]
  const parts: string[] = []

  const stalled = kind === 'instance' ? outcome.stalled.instances : outcome.stalled.bindings
  if (stalled > 0) {
    const one = stalled === 1

    // Two different routers, and the difference is not a nicety. Without a
    // bm-wanbind the rules stand and nothing maintains them; with one this
    // module cannot drive, that daemon owns the band and is removing them.
    // Saying the first about the second reports health while the bindings go.
    // `sweeping` is a fact about the one-to-one band and only that band. A
    // 3.3.x module wrote its one-to-one rules over SSH with no section behind
    // them, so a 2.3.x daemon - which owns that band and removes what no
    // section claims - is taking them off. It wrote its *instances* as
    // `config instance` sections and let the daemon run them, so on the same
    // router those rules are claimed, maintained, and going nowhere. Saying
    // otherwise would invent an outage on a half that is working.
    const rules = kind === 'binding' && outcome.sweeping
      ? `The bm-wanbind on this router is a release this module cannot drive, and it owns the ` +
        `priorities ${one ? 'that rule was' : 'those rules were'} written at - so it is taking ` +
        `${one ? 'it' : 'them'} off as fast as it finds ${one ? 'it' : 'them'}, and the address` +
        `${one ? '' : 'es'} ${one ? 'is' : 'are'} leaving by this router's default connection ` +
        `meanwhile. Updating the router packages is what stops that: the moment this module can ` +
        `drive the daemon, ${one ? 'the record is' : 'the records are'} handed over and the ` +
        `${one ? 'rule is' : 'rules are'} written back as sections it will keep.`
      : kind === 'instance' && outcome.sweeping
        ? `The sections ${one ? 'it was' : 'they were'} written into are on the router and the ` +
          `bm-wanbind there is running ${one ? 'it' : 'them'} - what this module cannot do is ` +
          `read or change ${one ? 'it' : 'them'}, because that release speaks a contract this ` +
          `one stopped driving. Updating the router packages is all of it: the moment this ` +
          `module can drive the daemon, ${one ? 'the record is' : 'the records are'} handed ` +
          `over and this half of the page comes back.`
        : `The ip rules ${one ? 'it was' : 'they were'} given still stand exactly as they were, ` +
          `but nothing is maintaining them now: ${UNMAINTAINED[kind]}. Installing the router ` +
          `packages hands ${one ? 'it' : 'them'} over by itself, and nothing here has to be pressed.`

    parts.push(
      `This module still holds ${stalled} ${one ? noun.one : noun.many} it created before ` +
        `the router kept its own. ${rules}`
    )
  }

  // Named one at a time, newest problem or not: a count on its own tells
  // somebody to be worried without telling them what about, and the reason is
  // the only thing that can be acted on.
  const refused = outcome.stranded.filter((entry) => entry.kind === kind)
  const first = refused[0]
  if (first) {
    const one = refused.length === 1
    parts.push(
      `${refused.length} ${one ? noun.one : noun.many} created by this module ` +
        `${one ? 'has' : 'have'} not been taken over by the router - "${first.name}" ` +
        `${first.reason}. This module writes no rule on a router that keeps its own ` +
        `binding, so nothing on either side is maintaining ${one ? 'it' : 'them'} meanwhile. ` +
        'The handover is retried on every pass, so fixing the reason is all that is needed.'
    )
  }

  return parts.join(' ')
}
