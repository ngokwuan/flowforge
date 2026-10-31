import { describe, expect, it } from 'vitest';
import { isBlockedAddress, isBlockedHostLiteral } from './network-guard';

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
  ])('blocks private or reserved IPv4 %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '93.184.216.34',
  ])('allows public IPv4 %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each([
    '::',
    '::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // the same address in hex form
    '::ffff:169.254.169.254',
    '::10.0.0.1',
    '64:ff9b::a00:1', // NAT64 wrapping 10.0.0.1
    '2002:7f00:1::', // 6to4 wrapping 127.0.0.1
  ])('blocks private or reserved IPv6 %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
    'allows public IPv6 %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it('fails closed for anything that is not an IP address', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
    expect(isBlockedAddress('999.1.1.1')).toBe(true);
  });
});

describe('isBlockedHostLiteral', () => {
  it('checks IP literals, including bracketed IPv6', () => {
    expect(isBlockedHostLiteral('127.0.0.1')).toBe(true);
    expect(isBlockedHostLiteral('[::1]')).toBe(true);
    expect(isBlockedHostLiteral('8.8.8.8')).toBe(false);
  });

  it('leaves DNS names to the connect-time check', () => {
    expect(isBlockedHostLiteral('example.com')).toBe(false);
    expect(isBlockedHostLiteral('localhost')).toBe(false);
  });

  it('sees through alternative spellings once the URL parser normalizes them', () => {
    expect(isBlockedHostLiteral(new URL('http://2130706433/').hostname)).toBe(
      true,
    ); // decimal 127.0.0.1
    expect(isBlockedHostLiteral(new URL('http://0x7f.1/').hostname)).toBe(true); // hex 127.0.0.1
    expect(
      isBlockedHostLiteral(new URL('http://[::ffff:127.0.0.1]/').hostname),
    ).toBe(true);
  });
});
