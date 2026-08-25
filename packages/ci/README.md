# Stubs and probes

[`scripts/check-ucode.sh`](../../scripts/check-ucode.sh) builds a host `ucode`
and runs every `.uc` file in this tree through it before anything is packaged.
Modules are **loaded**, entry points are compiled, and then the probes in
`probes/` drive the daemon code for real.

That catches the whole class of mistake that would otherwise reach a router: a
typo, an unbalanced brace, a name imported from a module that does not export
it, an exported function closed with `}` where ucode wants `};` - and, because
the modules are loaded rather than only compiled, anything that fails at module
scope. `const UNSAFE = /[\x00-\x1f\x7f]/` is the one that made the difference:
ucode hands a pattern to `regcomp`, POSIX has no `\x` escape, and regcomp
refuses it when the constant is *built*. A clean compile, and a package that
died on the router before one line of it ran.

ucode resolves `import { x } from 'y'` **at compile time** - it has to know what
`y` exports to compile the reference - so the check needs those modules to
exist. On the router they are C modules shipped by `ucode-mod-fs`,
`ucode-mod-ubus`, `ucode-mod-uci` and `ucode-mod-uloop`, and none of them build
on a plain Ubuntu runner without libubus and libuci.

So `stubs/` holds a `.uc` file per module, exporting the same names under the
same spelling and doing nothing at all. Put first on the search path, they let
every module resolve its imports and load without a libubus or a libuci
underneath - and, because they do nothing, without a syntax check writing
configuration on the machine running it.

**A stub is not a specification.** Adding a name here does not make it exist on
the router, and a passing check proves the file loads and imports names the stub
agrees exist. A probe proves rather more, but only about the code above the
stub: what netifd, dnsmasq and the kernel actually do with any of it is settled
by a real router, which is what the manual verification list in the module
README is for.

When new code imports a function these stubs do not have, the check fails with
the missing name - add it here in the same shape and move on.

## `probes/`

The other half. A build says a file is well formed; a probe says it is right,
which for this tree mostly means the arithmetic. A pool created one sequence
number too low silently rewrites another pool's credentials; an instance whose
priority range is 32 wide is dropped from every list the daemon builds with the
reason only in syslog. Neither is visible to a compiler, and both have happened.

Each probe is a program. It drives the real daemon modules, reads the answers
back, and prints `bm-probe-ok` on the last line if nothing was wrong. The runner
looks for that line rather than at the exit status, because **ucode exits 0 on
an uncaught exception** - a probe that died half way through would otherwise be
reported green.

`probes/lib/` holds what a probe needs and a stub must not be: a `uci` that
actually stores what it is given, so `pool-lifecycle.uc` can create a pool and
then read the sections back out of it. It is put on the search path only for the
probe run, which is why it is not in `stubs/`.

Adding one is adding a file to `probes/`; the runner picks it up. Keep them to
things a router would otherwise have to teach you.

Two shapes matter and are easy to get wrong. Close every `export function` with
`};`: an `export` is a statement, and without its semicolon the error is
reported against whatever line comes next, which is usually a comment. And a
module whose real exports include a ucode keyword - `rtnl` exports `const` -
simply omits it: every caller reaches it as `rtnl.const.X` through
`import * as rtnl`, which is a property lookup at run time and not a name the
compiler ever checks.
