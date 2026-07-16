import { isStrictJsonObject } from "../../src/net/strictJson.js";

let passed = 0;
let failed = 0;

function check(name: string, isPassing: boolean): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}\n`);
  }
}

check("scanner accepts structurally complex strings",
  isStrictJsonObject('{"text":"{a},[\\"b\\"]","unicode":"\\u2603","slash":"\\\\/","nested":{"items":[true,false,null,-12.5e+2]}}'));
check("scanner rejects duplicate top-level keys",
  !isStrictJsonObject('{"pid":"first","pid":"second"}'));
check("scanner compares decoded escaped key names",
  !isStrictJsonObject('{"p\\u0069d":"first","pid":"second"}'));
check("scanner rejects duplicate nested keys",
  !isStrictJsonObject('{"outer":{"value":1,"val\\u0075e":2}}'));
check("scanner keeps object scopes independent",
  isStrictJsonObject('{"left":{"id":1},"right":{"id":2}}'));
check("scanner rejects trailing tokens",
  !isStrictJsonObject('{"pid":"ok"} true'));
check("scanner requires one top-level object",
  !isStrictJsonObject('[{"pid":"ok"}]'));
check("scanner rejects malformed escapes",
  !isStrictJsonObject('{"pid":"\\x20"}'));
check("scanner rejects lone surrogate escapes",
  !isStrictJsonObject('{"pid":"\\ud800"}'));
check("scanner accepts a valid surrogate pair",
  isStrictJsonObject('{"pid":"\\ud83d\\ude80"}'));
check("scanner rejects noncanonical JSON numbers structurally",
  !isStrictJsonObject('{"exp":01}'));
check("scanner ignores delimiters inside strings",
  isStrictJsonObject('{"text":"quote: \\" comma, brace } bracket ]"}'));

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
