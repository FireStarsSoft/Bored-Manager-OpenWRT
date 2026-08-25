import { describe, expect, it } from 'vitest'
import {
  carrierScopesOverlap,
  ipv4ToInt,
  parseCidr,
  prefixMask,
  sameSubnet,
  subnetsOverlap
} from '../../openwrt/main/util'

/**
 * The six pure helpers every guard in the module is built out of. Each of them
 * is one line of arithmetic, and each of them has a way of returning a
 * confidently wrong answer rather than failing: a shift count JavaScript
 * truncates, a `Number()` that accepts `0x10` as an octet, a `startsWith` that
 * would call `eth1` and `eth10` the same wire. Nothing above them would notice
 * - `subnetsOverlap` returning false is exactly what a caller wants to hear.
 */

describe('reading an IPv4 address out of router output', () => {
  it('refuses the strings Number() would happily turn into an octet', () => {
    // Both of these are finite numbers, and both arrive as text lifted straight
    // out of `uci show` or a lease file. Parsed with `Number()`, `1e3` becomes
    // 1000 and `0x10` becomes 16, so an address that is not an address would
    // silently produce a subnet the LAN-overlap guard then compares against.
    expect(ipv4ToInt('192.168.1e3.1')).toBeNull()
    expect(ipv4ToInt('192.168.0x10.1')).toBeNull()
    expect(ipv4ToInt('192.168.+1.1')).toBeNull()
    expect(ipv4ToInt('192.168..1')).toBeNull()
  })

  it('refuses an octet over 255 and an address with the wrong number of parts', () => {
    expect(ipv4ToInt('192.168.1.256')).toBeNull()
    expect(ipv4ToInt('192.168.1')).toBeNull()
    expect(ipv4ToInt('192.168.1.1.1')).toBeNull()
  })

  it('reads the top of the range as an unsigned number', () => {
    // `>>> 0` is what keeps this positive. As a signed 32-bit value it is -1,
    // and every comparison built on it would then be against a negative
    // network number that no other address can equal.
    expect(ipv4ToInt('255.255.255.255')).toBe(4_294_967_295)
    expect(ipv4ToInt('  10.0.0.1  ')).toBe(ipv4ToInt('10.0.0.1'))
    expect(ipv4ToInt('0.0.0.0')).toBe(0)
  })
})

describe('the mask for a prefix length', () => {
  it('answers zero for /0 instead of shifting by nothing', () => {
    // JavaScript truncates a shift count to five bits, so `0xffffffff << 32`
    // is a shift by 0 and returns every bit set - the mask for /32. A caller
    // asking about a default route would have been told it matches one host.
    expect(prefixMask(0)).toBe(0)
  })

  it('answers the usual masks for the prefixes this module writes', () => {
    expect(prefixMask(8)).toBe(0xff000000)
    expect(prefixMask(24)).toBe(0xffffff00)
    expect(prefixMask(32)).toBe(0xffffffff)
  })
})

describe('parsing a CIDR', () => {
  it('drops the host bits so two spellings of one subnet compare equal', () => {
    // The LAN CIDR comes from an interface address, so it is nearly always a
    // host address with a prefix. Comparing `192.168.1.55/24` literally would
    // make an instance on `192.168.1.1/24` look like a different subnet.
    expect(parseCidr('192.168.1.55/24')).toEqual({
      network: ipv4ToInt('192.168.1.0'),
      prefix: 24,
      cidr: '192.168.1.0/24'
    })
  })

  it('refuses a prefix outside 0-32 rather than masking with a truncated shift', () => {
    expect(parseCidr('192.168.1.0/33')).toBeNull()
    expect(parseCidr('192.168.1.0/240')).toBeNull()
  })

  it('refuses anything that is not one address and one prefix', () => {
    expect(parseCidr('192.168.1.0')).toBeNull()
    expect(parseCidr('192.168.1.0/')).toBeNull()
    expect(parseCidr('999.1.1.1/24')).toBeNull()
    expect(parseCidr('')).toBeNull()
  })

  it('accepts /0 and keeps it distinguishable from a parse failure', () => {
    expect(parseCidr('10.1.2.3/0')).toEqual({ network: 0, prefix: 0, cidr: '0.0.0.0/0' })
  })
})

describe('whether two LAN subnets overlap', () => {
  const cidr = (value: string): NonNullable<ReturnType<typeof parseCidr>> => {
    const parsed = parseCidr(value)
    if (!parsed) throw new Error(`fixture ${value} does not parse`)
    return parsed
  }

  it('compares at the shorter prefix, so a /24 inside a /8 counts as overlapping', () => {
    // Source-only IPv4 rules cannot tell two clients apart when their subnets
    // contain each other, so a containing range is exactly the case the create
    // gate has to refuse. Comparing at the longer prefix would call these two
    // disjoint and let both instances be created.
    expect(subnetsOverlap(cidr('10.0.0.0/8'), cidr('10.1.2.0/24'))).toBe(true)
    expect(subnetsOverlap(cidr('10.1.2.0/24'), cidr('10.0.0.0/8'))).toBe(true)
  })

  it('leaves two neighbouring /24s alone', () => {
    expect(subnetsOverlap(cidr('192.168.1.0/24'), cidr('192.168.2.0/24'))).toBe(false)
  })

  it('treats a default route as overlapping everything', () => {
    expect(subnetsOverlap(cidr('0.0.0.0/0'), cidr('192.168.1.0/24'))).toBe(true)
  })
})

describe('whether two addresses share a subnet of a given length', () => {
  it('answers false for a prefix it cannot mask, instead of masking with the wrong one', () => {
    // This is the one caller that holds a raw prefix rather than a parsed CIDR,
    // so the range check is its own. Passed straight to `prefixMask`, 33 shifts
    // by 31 and compares only the top bit: every address in 128.0.0.0/1 would
    // have been reported as sharing a subnet with every other.
    expect(sameSubnet('192.168.1.1', '10.0.0.1', 33)).toBe(false)
    expect(sameSubnet('192.168.1.1', '10.0.0.1', -1)).toBe(false)
  })

  it('answers false when either address could not be read', () => {
    expect(sameSubnet('192.168.1.1', 'not-an-address', 24)).toBe(false)
    expect(sameSubnet('', '192.168.1.2', 24)).toBe(false)
  })

  it('answers the question it was asked for a prefix it can mask', () => {
    expect(sameSubnet('192.168.1.1', '192.168.1.254', 24)).toBe(true)
    expect(sameSubnet('192.168.1.1', '192.168.2.1', 24)).toBe(false)
    expect(sameSubnet('192.168.1.1', '10.0.0.1', 0)).toBe(true)
  })
})

describe('whether two carrier names describe overlapping sets of devices', () => {
  it('puts a VLAN inside the device it is tagged on', () => {
    // A binding instance claims a carrier exclusively and the PPPoE delete path
    // asks the same question before removing a pool. `eth1` is every VLAN on
    // that wire at once, so it has to clash with each of them.
    expect(carrierScopesOverlap('eth1', 'eth1.835')).toBe(true)
    expect(carrierScopesOverlap('eth1.835', 'eth1')).toBe(true)
    expect(carrierScopesOverlap('eth1', 'eth1')).toBe(true)
  })

  it('leaves two VLANs on one wire as two separate uplinks', () => {
    expect(carrierScopesOverlap('eth1.835', 'eth1.836')).toBe(false)
  })

  it('does not mistake a longer device name for a VLAN on a shorter one', () => {
    // The separator is what makes this safe. Matching on the bare prefix would
    // make `eth1` own `eth10` and `eth11`, so a single instance on the first
    // port would refuse every other port on the switch.
    expect(carrierScopesOverlap('eth1', 'eth10')).toBe(false)
    expect(carrierScopesOverlap('eth10', 'eth1')).toBe(false)
    expect(carrierScopesOverlap('br-lan', 'br-lan10')).toBe(false)
  })
})
