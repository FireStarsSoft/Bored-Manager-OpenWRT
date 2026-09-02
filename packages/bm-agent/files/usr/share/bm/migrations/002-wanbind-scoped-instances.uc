// Schema 2 -> 3: an instance may be scoped to an address range, and a WAN may
// carry more than one client.
//
// Moves nothing, and could not sensibly move anything: every `config instance`
// written before this release means the whole of its LAN and one client per
// WAN, and that is exactly what an absent `range_from`, `range_to` and
// `clients_per_wan` already read as. A step that wrote `clients_per_wan '1'`
// into every section would change nothing about the router and would rewrite a
// file somebody may have hand-edited, which is a worse trade than leaving it
// alone.
//
// The step exists for the gate rather than for the data, and the gate matters
// in one direction only. A 2.4.0 build on a schema-2 router is fine: it reads
// the old sections and defaults the three options. A 2.3.0 build on a schema-3
// router is not: it has no idea what `range_from` means, so an instance
// somebody scoped to twenty addresses would be reconciled as the whole LAN -
// with a whole-LAN fail-closed catch-all over every address the scope was
// written to leave alone. That is a silent outage on a router that was
// configured correctly, and refusing to start is the only honest answer to it.
//
// Idempotent by virtue of doing nothing, which is the shape every step has to
// have: it runs again after a crash between the change and the stamp.

return {
	from: 2,
	to: 3,
	describe: 'bm_wanbind instances may be scoped to an address range and seat several clients per WAN',
	apply: function(ctx) {
		ctx.notice('schema 3: existing bm_wanbind instances keep the whole of their LAN and one client per WAN');
	}
};
