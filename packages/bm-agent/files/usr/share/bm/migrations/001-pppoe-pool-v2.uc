// Schema 1 -> 2: the pool-of-members model for /etc/config/bm_pppoe.
//
// Deliberately moves nothing. Pool sections written by the old model - the
// ones with a `seq_from` - are not translated into member lists, because
// there is nothing safe to translate them into: the old shape shared one
// VLAN device between pools and derived five-digit section names the new
// reconcilers must never touch. The 2.0.0 daemon lists them under `legacy`,
// refuses everything but delete, and the person who owns the router decides
// when each one goes.
//
// What the step is for is the chain itself. The schema gate refuses to run
// new code against an unstamped-old router and old code against a newer
// stamp; this file is what lets `bmctl migrate` carry a schema-1 router
// forward to 2, and its emptiness is the statement that the data needs no
// carrying - only the stamp moves.
//
// Idempotent by virtue of doing nothing, which is the shape every step must
// have anyway: it runs again after a crash between the change and the stamp.

return {
	from: 1,
	to: 2,
	describe: 'bm_pppoe becomes pools of VLAN members; old pools stay for delete-only',
	apply: function(ctx) {
		ctx.notice('schema 2: legacy PPPoE pools are kept as-is, delete-only');
	}
};
