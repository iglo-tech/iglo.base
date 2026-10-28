// Upstream: govalidator a9d515a09cc2 validator_test.go
import { expect, test } from "bun:test";
import {
  IsDNSName,
  IsEmail,
  IsHexcolor,
  IsHost,
  IsIP,
  IsJSON,
  IsURL,
} from "@/validation/is/govalidator";

test.each<[string, boolean]>([
  ["", false],
  ["foo@bar.com", true],
  ["x@x.x", true],
  ["foo@bar.com.au", true],
  ["foo+bar@bar.com", true],
  ["foo@bar.coffee", true],
  ["foo@bar.coffee..coffee", false],
  ["foo@bar.bar.coffee", true],
  ["foo@bar.中文网", true],
  ["invalidemail@", false],
  ["invalid.com", false],
  ["@invalid.com", false],
  ["test|123@m端ller.com", true],
  ["hans@m端ller.com", true],
  ["hans.m端ller@test.com", true],
  ["NathAn.daVIeS@DomaIn.cOM", true],
  ["NATHAN.DAVIES@DOMAIN.CO.UK", true],
])("TestIsEmail %p", (param, expected) => {
  expect(IsEmail(param)).toBe(expected);
});

test.each<[string, boolean]>([
  ["", false],
  ["http://foo.bar#com", true],
  ["http://foobar.com", true],
  ["https://foobar.com", true],
  ["foobar.com", true],
  ["http://foobar.coffee/", true],
  ["http://foobar.中文网/", true],
  ["http://foobar.org/", true],
  ["http://foobar.ORG", true],
  ["http://foobar.org:8080/", true],
  ["ftp://foobar.ru/", true],
  ["ftp.foo.bar", true],
  ["http://user:pass@www.foobar.com/", true],
  ["http://user:pass@www.foobar.com/path/file", true],
  ["http://127.0.0.1/", true],
  ["http://duckduckgo.com/?q=%2F", true],
  ["http://localhost:3000/", true],
  ["http://foobar.com/?foo=bar#baz=qux", true],
  ["http://foobar.com?foo=bar", true],
  ["http://www.xn--froschgrn-x9a.net/", true],
  ["http://foobar.com/a-", true],
  ["http://foobar.پاکستان/", true],
  ["http://foobar.c_o_m", false],
  ["http://_foobar.com", false],
  ["http://foo_bar.com", true],
  ["http://user:pass@foo_bar_bar.bar_foo.com", true],
  ["", false],
  ["xyz://foobar.com", false],
  // {"invalid.", false}, is it false like "localhost."?
  [".com", false],
  ["rtmp://foobar.com", false],
  ["http://localhost:3000/", true],
  ["http://foobar.com#baz=qux", true],
  ["http://foobar.com/t$-_.+!*\\'(),", true],
  ["http://www.foobar.com/~foobar", true],
  ["http://www.-foobar.com/", false],
  ["http://www.foo---bar.com/", false],
  ["http://r6---snnvoxuioq6.googlevideo.com", true],
  ["mailto:someone@example.com", true],
  ["irc://irc.server.org/channel", false],
  ["irc://#channel@network", true],
  ["/abs/test/dir", false],
  ["./rel/test/dir", false],
  ["http://foo^bar.org", false],
  ["http://foo&*bar.org", false],
  ["http://foo&bar.org", false],
  ["http://foo bar.org", false],
  ["http://foo.bar.org", true],
  ["http://www.foo.bar.org", true],
  ["http://www.foo.co.uk", true],
  ["foo", false],
  ["http://.foo.com", false],
  ["http://,foo.com", false],
  [",foo.com", false],
  ["http://myservice.:9093/", true],
  // according to issues #62 #66
  ["https://pbs.twimg.com/profile_images/560826135676588032/j8fWrmYY_normal.jpeg", true],
  // according to #125
  ["http://prometheus-alertmanager.service.q:9093", true],
  ["aio1_alertmanager_container-63376c45:9093", true],
  ["https://www.logn-123-123.url.with.sigle.letter.d:12345/url/path/foo?bar=zzz#user", true],
  ["http://me.example.com", true],
  ["http://www.me.example.com", true],
  ["https://farm6.static.flickr.com", true],
  ["https://zh.wikipedia.org/wiki/Wikipedia:%E9%A6%96%E9%A1%B5", true],
  ["google", false],
  // According to #87
  ["http://hyphenated-host-name.example.co.in", true],
  ["http://cant-end-with-hyphen-.example.com", false],
  ["http://-cant-start-with-hyphen.example.com", false],
  ["http://www.domain-can-have-dashes.com", true],
  ["http://m.abcd.com/test.html", true],
  ["http://m.abcd.com/a/b/c/d/test.html?args=a&b=c", true],
  ["http://[::1]:9093", true],
  ["http://[::1]:909388", false],
  ["1200::AB00:1234::2552:7777:1313", false],
  ["http://[2001:db8:a0b:12f0::1]/index.html", true],
  ["http://[1200:0000:AB00:1234:0000:2552:7777:1313]", true],
  ["http://user:pass@[::1]:9093/a/b/c/?a=v#abc", true],
  ["https://127.0.0.1/a/b/c?a=v&c=11d", true],
  ["https://foo_bar.example.com", true],
  ["http://foo_bar.example.com", true],
  ["http://foo_bar_fizz_buzz.example.com", true],
  ["http://_cant_start_with_underescore", false],
  ["http://cant_end_with_underescore_", false],
  ["foo_bar.example.com", true],
  ["foo_bar_fizz_buzz.example.com", true],
  ["http://hello_world.example.com", true],
  // According to #212
  ["foo_bar-fizz-buzz:1313", true],
  ["foo_bar-fizz-buzz:13:13", false],
  ["foo_bar-fizz-buzz://1313", false],
])("TestIsURL %p", (param, expected) => {
  expect(IsURL(param)).toBe(expected);
});

test.each<[string, boolean]>([
  ["localhost", true],
  ["a.bc", true],
  ["a.b.", true],
  ["a.b..", false],
  ["localhost.local", true],
  ["localhost.localdomain.intern", true],
  ["l.local.intern", true],
  ["ru.link.n.svpncloud.com", true],
  ["-localhost", false],
  ["localhost.-localdomain", false],
  ["localhost.localdomain.-int", false],
  ["_localhost", true],
  ["localhost._localdomain", true],
  ["localhost.localdomain._int", true],
  ["lÖcalhost", false],
  ["localhost.lÖcaldomain", false],
  ["localhost.localdomain.üntern", false],
  ["__", true],
  ["localhost/", false],
  ["127.0.0.1", false],
  ["[::1]", false],
  ["50.50.50.50", false],
  ["localhost.localdomain.intern:65535", false],
  ["漢字汉字", false],
  [
    "www.jubfvq1v3p38i51622y0dvmdk1mymowjyeu26gbtw9andgynj1gg8z3msb1kl5z6906k846pj3sulm4kiyk82ln5teqj9nsht59opr0cs5ssltx78lfyvml19lfq1wp4usbl0o36cmiykch1vywbttcus1p9yu0669h8fj4ll7a6bmop505908s1m83q2ec2qr9nbvql2589adma3xsq2o38os2z3dmfh2tth4is4ixyfasasasefqwe4t2ub2fz1rme.de",
    false,
  ],
])("TestIsDNSName %p", (param, expected) => {
  expect(IsDNSName(param)).toBe(expected);
});

test.each<[string, boolean]>([
  ["localhost", true],
  ["localhost.localdomain", true],
  ["2001:db8:0000:1:1:1:1:1", true],
  ["::1", true],
  ["play.golang.org", true],
  ["localhost.localdomain.intern:65535", false],
  ["-[::1]", false],
  ["-localhost", false],
  [".localhost", false],
])("TestIsHost %p", (param, expected) => {
  expect(IsHost(param)).toBe(expected);
});

test.each<[string, boolean]>([
  ["", false],
  ["127.0.0.1", true],
  ["0.0.0.0", true],
  ["255.255.255.255", true],
  ["1.2.3.4", true],
  ["::1", true],
  ["2001:db8:0000:1:1:1:1:1", true],
  ["300.0.0.0", false],
])("TestIsIP %p", (param, expected) => {
  expect(IsIP(param)).toBe(expected);
});

test.each<[string, boolean]>([
  ["", false],
  ["#ff", false],
  ["fff0", false],
  ["#ff12FG", false],
  ["CCccCC", true],
  ["fff", true],
  ["#f00", true],
])("TestIsHexcolor %p", (param, expected) => {
  expect(IsHexcolor(param)).toBe(expected);
});

test.each<[string, boolean]>([
  ["", false],
  ["145", true],
  ["asdf", false],
  ["123:f00", false],
  ['{"Name":"Alice","Body":"Hello","Time":1294706395881547000}', true],
  ["{}", true],
  ['{"Key":{"Key":{"Key":123}}}', true],
  ["[]", true],
  ["null", true],
])("TestIsJSON %p", (param, expected) => {
  expect(IsJSON(param)).toBe(expected);
});
