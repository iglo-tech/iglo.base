// Upstream: gabriel-vasile/mimetype v1.4.15 internal/json/parser_test.go

import { describe, expect, test } from "bun:test";

import { type query, parserState } from "@/tools/mimetype/internal/json/parser";
import { Bytes } from "@/tools/mimetype/internal/scan/bytes";
import { bytesToText, textToBytes } from "@/tools/types/go-json";
import { g, raw } from "@test/tools/mimetype/go-literal";

// These samples come from https://github.com/nst/JSONTestSuite.
const positives: { json: Uint8Array; stdlib: boolean }[] = [
  { json: raw("[[]   ]"), stdlib: true },
  { json: raw("[]"), stdlib: true },
  { json: raw('[""]'), stdlib: true },
  { json: raw('["a"]'), stdlib: true },
  { json: raw("[false]"), stdlib: true },
  { json: raw('[null, 1, "1", {}]'), stdlib: true },
  { json: raw("[null]"), stdlib: true },
  { json: raw("[1\n]"), stdlib: true },
  { json: raw(" [1]"), stdlib: true },
  { json: raw("[1,null,null,null,2]"), stdlib: true },
  { json: raw("[2] "), stdlib: true },
  { json: raw("[0e+1]"), stdlib: true },
  { json: raw("[0e1]"), stdlib: true },
  { json: raw("[ 4]"), stdlib: true },
  {
    json: raw(
      "[-0.000000000000000000000000000000000000000000000000000000000000000000000000000001]\n",
    ),
    stdlib: true,
  },
  { json: raw("[20e1]"), stdlib: true },
  { json: raw("[123e65]"), stdlib: true },
  { json: raw("[-0]"), stdlib: true },
  { json: raw("[-123]"), stdlib: true },
  { json: raw("[-1]"), stdlib: true },
  { json: raw("[-0]"), stdlib: true },
  { json: raw("[1E22]"), stdlib: true },
  { json: raw("[1E-2]"), stdlib: true },
  { json: raw("[1E+2]"), stdlib: true },
  { json: raw("[123e45]"), stdlib: true },
  { json: raw("[123.456e78]"), stdlib: true },
  { json: raw("[1e-2]"), stdlib: true },
  { json: raw("[1e+2]"), stdlib: true },
  { json: raw("[123]"), stdlib: true },
  { json: raw("[123.456789]"), stdlib: true },
  { json: raw('{"asd":"sdf"}'), stdlib: true },
  { json: raw('{"a":"b","a":"b"}'), stdlib: true },
  { json: raw('{"a":"b","a":"c"}'), stdlib: true },
  { json: raw("{}"), stdlib: true },
  { json: raw('{"":0}'), stdlib: true },
  { json: raw('{"foo\\u0000bar": 42}'), stdlib: true },
  { json: raw('{ "min": -1.0e+28, "max": 1.0e+28 }'), stdlib: true },
  { json: raw('{"asd":"sdf", "dfg":"fgh"}'), stdlib: true },
  {
    json: raw(
      '{"x":[{"id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}], "id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}',
    ),
    stdlib: true,
  },
  { json: raw('{"a":[]}'), stdlib: true },
  {
    json: raw(
      '{"title":"\\u041f\\u043e\\u043b\\u0442\\u043e\\u0440\\u0430 \\u0417\\u0435\\u043c\\u043b\\u0435\\u043a\\u043e\\u043f\\u0430" }',
    ),
    stdlib: true,
  },
  { json: raw('{\n"a": "b"\n}'), stdlib: true },
  { json: raw('["\\u0060\\u012a\\u12AB"]'), stdlib: true },
  { json: raw('["\\uD801\\udc37"]'), stdlib: true },
  { json: raw('["\\ud83d\\ude39\\ud83d\\udc8d"]'), stdlib: true },
  { json: raw('["\\"\\\\\\/\\b\\f\\n\\r\\t"]'), stdlib: true },
  { json: raw('["\\\\u0000"]'), stdlib: true },
  { json: raw('["\\""]'), stdlib: true },
  { json: raw('["a/*b*/c/*d//e"]'), stdlib: true },
  { json: raw('["\\\\a"]'), stdlib: true },
  { json: raw('["\\\\n"]'), stdlib: true },
  { json: raw('["\\u0012"]'), stdlib: true },
  { json: raw('["\\uFFFF"]'), stdlib: true },
  { json: raw('["asd"]'), stdlib: true },
  { json: raw('[ "asd"]'), stdlib: true },
  { json: raw('["\\uDBFF\\uDFFF"]'), stdlib: true },
  { json: raw('["new\\u00A0line"]'), stdlib: true },
  { json: raw('["􏿿"]'), stdlib: true },
  { json: raw('["￿"]'), stdlib: true },
  { json: raw('["\\u0000"]'), stdlib: true },
  { json: raw('["\\u002c"]'), stdlib: true },
  { json: raw('["π"]'), stdlib: true },
  { json: raw('["𛿿"]'), stdlib: true },
  { json: raw('["asd "]'), stdlib: true },
  { json: raw('" "'), stdlib: true },
  { json: raw('["\\uD834\\uDd1e"]'), stdlib: true },
  { json: raw('["\\u0821"]'), stdlib: true },
  { json: raw('["\\u0123"]'), stdlib: true },
  { json: raw('[" "]'), stdlib: true },
  { json: raw('[" "]'), stdlib: true },
  { json: raw('["new\\u000Aline"]'), stdlib: true },
  { json: raw('["\\u0061\\u30af\\u30EA\\u30b9"]'), stdlib: true },
  { json: raw('[""]'), stdlib: true },
  { json: raw('["⍂㈴⍂"]'), stdlib: true },
  { json: raw('["\\u005C"]'), stdlib: true },
  { json: raw('["\\u0022"]'), stdlib: true },
  { json: raw('["\\uA66D"]'), stdlib: true },
  { json: raw('["\\uDBFF\\uDFFE"]'), stdlib: true },
  { json: raw('["\\uD83F\\uDFFE"]'), stdlib: true },
  { json: raw('["\\u200B"]'), stdlib: true },
  { json: raw('["\\u2064"]'), stdlib: true },
  { json: raw('["\\uFDD0"]'), stdlib: true },
  { json: raw('["\\uFFFE"]'), stdlib: true },
  { json: raw('["€𝄞"]'), stdlib: true },
  { json: raw('["aa"]'), stdlib: true },
  { json: raw("false"), stdlib: true },
  { json: raw("42"), stdlib: true },
  { json: raw("-0.1"), stdlib: true },
  { json: raw("null"), stdlib: true },
  { json: raw('"asd"'), stdlib: true },
  { json: raw("true"), stdlib: true },
  { json: raw('""'), stdlib: true },
  { json: raw('["a"]\n'), stdlib: true },
  { json: raw("[true]"), stdlib: true },
  { json: raw(" [] "), stdlib: true },
  { json: raw("    "), stdlib: false },
  { json: raw('["",]'), stdlib: false },
  { json: raw("[1,]"), stdlib: false },
  { json: raw("[-01]"), stdlib: false },
  { json: raw("[-2.]"), stdlib: false },
  { json: raw("[.2e-3]"), stdlib: false },
  { json: raw("[0.e1]"), stdlib: false },
  { json: raw("[2.e+3]"), stdlib: false },
  { json: raw("[2.e-3]"), stdlib: false },
  { json: raw("[2.e3]"), stdlib: false },
  { json: raw("[-012]"), stdlib: false },
  { json: raw("[-.123]"), stdlib: false },
  { json: raw("[1.]"), stdlib: false },
  { json: raw("[.123]"), stdlib: false },
  { json: raw("[012]"), stdlib: false },
  { json: raw('{"�":"0",}'), stdlib: false },
  { json: raw('{"id":0,}'), stdlib: false },
  { json: raw('"'), stdlib: false },
  { json: raw('["new\nline"]'), stdlib: false },
  { json: raw('["\t"]'), stdlib: false },
  { json: raw("["), stdlib: false },
  { json: raw("[["), stdlib: false },
  { json: raw("{"), stdlib: false },
];

// Bug: following samples are invalid JSONs but they are parsed successfully.
const negatives: [name: string, json: Uint8Array, expectParse: number, expectInspect: number][] = [
  ["array_1_true_without_comma", raw("[1 true]"), 1, 3],
  ["array_a_invalid_utf8", raw("[a�]"), 1, 1],
  ["array_colon_instead_of_comma", raw('["": 1]'), 1, 3],
  ["array_comma_after_close", raw('[""],'), 4, 4],
  ["array_comma_and_number", raw("[,1]"), 1, 1],
  ["array_double_comma", raw("[1,,2]"), 1, 3],
  ["array_double_extra_comma", raw('["x",,]'), 1, 5],
  ["array_extra_close", raw('["x"]]'), 5, 5],
  ["array_incomplete_invalid_value", raw("[x"), 1, 1],
  ["array_incomplete", raw('["x"'), 1, 4],
  ["array_inner_array_no_comma", raw("[3[4]]"), 1, 2],
  ["array_invalid_utf8", raw("[�]"), 1, 1],
  ["array_items_separated_by_semicolon", raw("[1:2]"), 1, 2],
  ["array_just_comma", raw("[,]"), 1, 1],
  ["array_just_minus", raw("[-]"), 1, 2],
  ["array_missing_value", raw('[   , ""]'), 1, 4],
  ["array_newlines_unclosed", raw('["a",\n4\n,1,'), 1, 11],
  ["array_number_and_several_commas", raw("[1,,]"), 1, 3],
  ["array_spaces_vertical_tab_formfeed", g`\x5b\x22\x0b\x61\x22\x5c\x66\x5d`, 1, 5],
  ["array_star_inside", raw("[*]"), 1, 1],
  ["array_unclosed", raw('[""'), 1, 3],
  ["array_unclosed_trailing_comma", raw("[1,"), 1, 3],
  ["array_unclosed_with_new_lines", g`\x5b\x31\x2c\x0a\x31\x0a\x2c\x31`, 1, 8],
  ["array_unclosed_with_object_inside", raw("[{}"), 1, 3],
  ["incomplete_false", raw("[fals]"), 1, 5],
  ["incomplete_null", raw("[nul]"), 1, 4],
  ["incomplete_true", raw("[tru]"), 1, 4],
  ["multidigit_number_then_00", g`\x31\x32\x33\x00`, 3, 3],
  ["number_0.1.2", raw("[0.1.2]"), 1, 4],
  ["number_0.3e+", raw("[0.3e+]"), 1, 6],
  ["number_0.3e", raw("[0.3e]"), 1, 5],
  ["number_0_capital_E+", raw("[0E+]"), 1, 4],
  ["number_0_capital_E", raw("[0E]"), 1, 3],
  ["number_0e+", raw("[0e+]"), 1, 4],
  ["number_0e", raw("[0e]"), 1, 3],
  ["number_1_000", raw("[1 000.0]"), 1, 3],
  ["number_1.0e+", raw("[1.0e+]"), 1, 6],
  ["number_1.0e-", raw("[1.0e-]"), 1, 6],
  ["number_1.0e", raw("[1.0e]"), 1, 5],
  ["number_-1.0.", raw("[-1.0.]"), 1, 5],
  ["number_1eE2", raw("[1eE2]"), 1, 3],
  ["number_+1", raw("[+1]"), 1, 1],
  ["number_.-1", raw("[.-1]"), 1, 2],
  ["number_9.e+", raw("[9.e+]"), 1, 5],
  ["number_expression", raw("[1+2]"), 1, 2],
  ["number_hex_1_digit", raw("[0x1]"), 1, 2],
  ["number_hex_2_digits", raw("[0x42]"), 1, 2],
  ["number_infinity", raw("[Infinity]"), 1, 1],
  ["number_+Inf", raw("[+Inf]"), 1, 1],
  ["number_Inf", raw("[Inf]"), 1, 1],
  ["number_invalid+-", raw("[0e+-1]"), 1, 4],
  ["number_invalid-negative-real", raw("[-123.123foo]"), 1, 9],
  ["number_invalid-utf-8-in-bigger-int", raw("[123�]"), 1, 4],
  ["number_invalid-utf-8-in-exponent", raw("[1e1�]"), 1, 4],
  ["number_invalid-utf-8-in-int", g`\x5b\x30\xe5\x5d\x0a`, 1, 2],
  ["number_++", raw("[++1234]"), 1, 1],
  ["number_minus_infinity", raw("[-Infinity]"), 1, 2],
  ["number_minus_sign_with_trailing_garbage", raw("[-foo]"), 1, 2],
  ["number_minus_space_1", raw("[- 1]"), 1, 2],
  ["number_-NaN", raw("[-NaN]"), 1, 2],
  ["number_NaN", raw("[NaN]"), 1, 1],
  ["number_neg_with_garbage_at_end", raw("[-1x]"), 1, 3],
  ["number_real_garbage_after_e", raw("[1ea]"), 1, 3],
  ["number_real_with_invalid_utf8_after_e", raw("[1e�]"), 1, 3],
  ["number_U+FF11_fullwidth_digit_one", raw("[１]"), 1, 1],
  ["number_with_alpha_char", raw("[1.8011670033376514H-308]"), 1, 19],
  ["number_with_alpha", raw("[1.2a-3]"), 1, 4],
  ["object_bad_value", raw('["x", truth]'), 1, 9],
  ["object_bracket_key", g`\x7b\x5b\x3a\x20\x22\x78\x22\x7d\x0a`, 1, 1],
  ["object_comma_instead_of_colon", raw('{"x", null}'), 1, 4],
  ["object_double_colon", raw('{"x"::"b"}'), 1, 5],
  ["object_emoji", raw("{🇨🇭}"), 1, 1],
  ["object_garbage_at_end", raw('{"a":"a" 123}'), 1, 9],
  ["object_key_with_single_quotes", raw("{key: 'value'}"), 1, 1],
  ["object_missing_colon", raw('{"a" b}'), 1, 5],
  ["object_missing_key", raw('{:"b"}'), 1, 1],
  ["object_missing_semicolon", raw('{"a" "b"}'), 1, 5],
  ["object_missing_value", raw('{"a":'), 1, 5],
  ["object_no-colon", raw('{"a"'), 1, 4],
  ["object_non_string_key_but_huge_number_instead", raw("{9999E9999:1}"), 1, 1],
  ["object_non_string_key", raw("{1:1}"), 1, 1],
  ["object_repeated_null_null", raw("{null:null,null:null}"), 1, 1],
  ["object_several_trailing_commas", raw('{"id":0,,,,,}'), 1, 8],
  ["object_single_quote", raw("{'a':0}"), 1, 1],
  ["object_trailing_comment", raw('{"a":"b"}/**/'), 9, 9],
  ["object_trailing_comment_open", raw('{"a":"b"}/**//'), 9, 9],
  ["object_trailing_comment_slash_open_incomplete", raw('{"a":"b"}/'), 9, 9],
  ["object_trailing_comment_slash_open", raw('{"a":"b"}//'), 9, 9],
  ["object_two_commas_in_a_row", raw('{"a":"b",,"c":"d"}'), 1, 9],
  ["object_unquoted_key", raw('{a: "b"}'), 1, 1],
  ["object_unterminated-value", raw('{"a":"a'), 1, 7],
  ["object_with_single_string", raw('{ "foo" : "bar", "a" }'), 1, 21],
  ["object_with_trailing_garbage", raw('{"a":"b"}#'), 9, 9],
  ["single_space", raw(" "), 0, 1],
  ["string_1_surrogate_then_escape", raw('["\\uD800\\"]'), 1, 11],
  ["string_1_surrogate_then_escape_u1", raw('["\\uD800\\u1"]'), 1, 11],
  ["string_1_surrogate_then_escape_u1x", raw('["\\uD800\\u1x"]'), 1, 11],
  ["string_1_surrogate_then_escape_u", raw('["\\uD800\\u"]'), 1, 10],
  ["string_accentuated_char_no_quotes", raw("[é]"), 1, 1],
  ["string_backslash_00", g`\x5b\x22\x5c\x00\x22\x5d`, 1, 3],
  ["string_escaped_backslash_bad", raw('["\\\\\\"]'), 1, 7],
  ["string_escaped_ctrl_char_tab", g`\x5b\x22\x5c\x09\x22\x5d`, 1, 3],
  ["string_escaped_emoji", raw('["\\🌀"]'), 1, 3],
  ["string_escape_x", raw('["\\x00"]'), 1, 3],
  ["string_incomplete_escaped_character", raw('["\\u00A"]'), 1, 7],
  ["string_incomplete_escape", raw('["\\"]'), 1, 5],
  ["string_incomplete_surrogate_escape_invalid", raw('["\\uD800\\uD800\\x"]'), 1, 15],
  ["string_incomplete_surrogate", raw('["\\uD834\\uDd"]'), 1, 12],
  ["string_invalid_backslash_esc", raw('["\\a"]'), 1, 3],
  ["string_invalid_unicode_escape", raw('["\\uqqqq"]'), 1, 4],
  ["string_invalid_utf8_after_escape", raw('["\\�"]'), 1, 3],
  ["string_invalid-utf-8-in-escape", raw('["\\u�"]'), 1, 4],
  ["string_leading_uescaped_thinspace", raw('[\\u0020"asd"]'), 1, 1],
  ["string_no_quotes_with_bad_escape", raw("[\\n]"), 1, 1],
  ["string_single_quote", raw("['single quote']"), 1, 1],
  ["string_single_string_no_double_quotes", raw("abc"), 0, 0],
  ["string_start_escape_unclosed", raw('["\\'), 1, 3],
  ["string_unicode_CapitalU", raw('"\\UA66D"'), 1, 2],
  ["string_with_trailing_garbage", raw('""x'), 2, 2],
  ["structure_angle_bracket_.", raw("<.>"), 0, 0],
  ["structure_angle_bracket_null", raw("[<null>]"), 1, 1],
  ["structure_array_trailing_garbage", raw("[1]x"), 3, 3],
  ["structure_array_with_extra_array_close", raw("[1]]"), 3, 3],
  ["structure_array_with_unclosed_string", raw('["asd]'), 1, 6],
  ["structure_ascii-unicode-identifier", raw("aå"), 0, 0],
  ["structure_capitalized_True", raw("[True]"), 1, 1],
  ["structure_close_unopened_array", raw("1]"), 1, 1],
  ["structure_comma_instead_of_closing_brace", raw('{"x": true,'), 1, 11],
  ["structure_double_array", raw("[][]"), 2, 2],
  ["structure_end_array", raw("]"), 0, 0],
  ["structure_incomplete_UTF8_BOM", raw("�{}"), 0, 0],
  ["structure_lone-invalid-utf-8", raw("�"), 0, 0],
  ["structure_null-byte-outside-string", g`\x5b\x00\x5d`, 1, 1],
  ["structure_number_with_trailing_garbage", raw("2@"), 1, 1],
  ["structure_object_followed_by_closing_object", raw("{}}"), 2, 2],
  ["structure_object_unclosed_no_value", raw('{"":'), 1, 4],
  ["structure_object_with_comment", raw('{"a":/*comment*/"b"}'), 1, 5],
  ["structure_object_with_trailing_garbage", raw('{"a": true} "x"'), 12, 12],
  ["structure_open_array_apostrophe", raw("['"), 1, 1],
  ["structure_open_array_comma", raw("[,"), 1, 1],
  ["structure_open_array_open_object", raw("[{"), 1, 2],
  ["structure_open_array_open_string", raw('["a'), 1, 3],
  ["structure_open_array_string", raw('["a"'), 1, 4],
  ["structure_open_object_close_array", raw("{]"), 1, 1],
  ["structure_open_object_comma", raw("{,"), 1, 1],
  ["structure_open_object_open_array", raw("{["), 1, 1],
  ["structure_open_object_open_string", raw('{"a'), 1, 3],
  ["structure_open_object_string_with_apostrophes", raw("{'a'"), 1, 1],
  ["structure_open_open", raw('["\\{["\\{["\\{["\\{'), 1, 3],
  ["structure_single_eacute", raw("�"), 0, 0],
  ["structure_single_star", raw("*"), 0, 0],
  ["structure_trailing_#", raw('{"a":"b"}#{}'), 9, 9],
  ["structure_U+2060_word_joined", g`\x5b\xe2\x81\xa0\x5d`, 1, 1],
  ["structure_uescaped_LF_before_string", raw('[\\u000A""]'), 1, 1],
  ["structure_unclosed_array", raw("[1"), 1, 2],
  ["structure_unclosed_array_partial_null", raw("[ false, nul"), 1, 12],
  ["structure_unclosed_array_unfinished_false", raw("[ true, fals"), 1, 12],
  ["structure_unclosed_array_unfinished_true", raw("[ false, tru"), 1, 12],
  ["structure_unclosed_object", raw('{"asd":"asd"'), 1, 12],
  ["structure_unicode-identifier", raw("å"), 0, 0],
  ["structure_UTF8_BOM_no_data", g`\xef\xbb\xbf`, 0, 0],
  ["structure_whitespace_formfeed", g`\x5b\x0c\x5d`, 1, 1],
  ["structure_whitespace_U+2060_word_joiner", g`\x5b\xe2\x81\xa0\x5d`, 1, 1],
];

// Output of Go's encoding/json Compact and Indent for each positive with
// stdlib true, generated by running those functions from the Go standard
// library. indents is in the order of the Go indents table: {"", " "},
// {" ", " "}, {" ", "\t"}, {"\t", "\t"}, {"\t", " \t"}, {"", "\r\n"},
// {"", " \r\n"}.
const stdlibGolden: { json: string; compact: string; indents: string[] }[] = [
  {
    json: "[[]   ]",
    compact: "[[]]",
    indents: [
      "[\n []\n]",
      "[\n  []\n ]",
      "[\n \t[]\n ]",
      "[\n\t\t[]\n\t]",
      "[\n\t \t[]\n\t]",
      "[\n\r\n[]\n]",
      "[\n \r\n[]\n]",
    ],
  },
  {
    json: "[]",
    compact: "[]",
    indents: ["[]", "[]", "[]", "[]", "[]", "[]", "[]"],
  },
  {
    json: '[""]',
    compact: '[""]',
    indents: [
      '[\n ""\n]',
      '[\n  ""\n ]',
      '[\n \t""\n ]',
      '[\n\t\t""\n\t]',
      '[\n\t \t""\n\t]',
      '[\n\r\n""\n]',
      '[\n \r\n""\n]',
    ],
  },
  {
    json: '["a"]',
    compact: '["a"]',
    indents: [
      '[\n "a"\n]',
      '[\n  "a"\n ]',
      '[\n \t"a"\n ]',
      '[\n\t\t"a"\n\t]',
      '[\n\t \t"a"\n\t]',
      '[\n\r\n"a"\n]',
      '[\n \r\n"a"\n]',
    ],
  },
  {
    json: "[false]",
    compact: "[false]",
    indents: [
      "[\n false\n]",
      "[\n  false\n ]",
      "[\n \tfalse\n ]",
      "[\n\t\tfalse\n\t]",
      "[\n\t \tfalse\n\t]",
      "[\n\r\nfalse\n]",
      "[\n \r\nfalse\n]",
    ],
  },
  {
    json: '[null, 1, "1", {}]',
    compact: '[null,1,"1",{}]',
    indents: [
      '[\n null,\n 1,\n "1",\n {}\n]',
      '[\n  null,\n  1,\n  "1",\n  {}\n ]',
      '[\n \tnull,\n \t1,\n \t"1",\n \t{}\n ]',
      '[\n\t\tnull,\n\t\t1,\n\t\t"1",\n\t\t{}\n\t]',
      '[\n\t \tnull,\n\t \t1,\n\t \t"1",\n\t \t{}\n\t]',
      '[\n\r\nnull,\n\r\n1,\n\r\n"1",\n\r\n{}\n]',
      '[\n \r\nnull,\n \r\n1,\n \r\n"1",\n \r\n{}\n]',
    ],
  },
  {
    json: "[null]",
    compact: "[null]",
    indents: [
      "[\n null\n]",
      "[\n  null\n ]",
      "[\n \tnull\n ]",
      "[\n\t\tnull\n\t]",
      "[\n\t \tnull\n\t]",
      "[\n\r\nnull\n]",
      "[\n \r\nnull\n]",
    ],
  },
  {
    json: "[1\n]",
    compact: "[1]",
    indents: [
      "[\n 1\n]",
      "[\n  1\n ]",
      "[\n \t1\n ]",
      "[\n\t\t1\n\t]",
      "[\n\t \t1\n\t]",
      "[\n\r\n1\n]",
      "[\n \r\n1\n]",
    ],
  },
  {
    json: " [1]",
    compact: "[1]",
    indents: [
      "[\n 1\n]",
      "[\n  1\n ]",
      "[\n \t1\n ]",
      "[\n\t\t1\n\t]",
      "[\n\t \t1\n\t]",
      "[\n\r\n1\n]",
      "[\n \r\n1\n]",
    ],
  },
  {
    json: "[1,null,null,null,2]",
    compact: "[1,null,null,null,2]",
    indents: [
      "[\n 1,\n null,\n null,\n null,\n 2\n]",
      "[\n  1,\n  null,\n  null,\n  null,\n  2\n ]",
      "[\n \t1,\n \tnull,\n \tnull,\n \tnull,\n \t2\n ]",
      "[\n\t\t1,\n\t\tnull,\n\t\tnull,\n\t\tnull,\n\t\t2\n\t]",
      "[\n\t \t1,\n\t \tnull,\n\t \tnull,\n\t \tnull,\n\t \t2\n\t]",
      "[\n\r\n1,\n\r\nnull,\n\r\nnull,\n\r\nnull,\n\r\n2\n]",
      "[\n \r\n1,\n \r\nnull,\n \r\nnull,\n \r\nnull,\n \r\n2\n]",
    ],
  },
  {
    json: "[2] ",
    compact: "[2]",
    indents: [
      "[\n 2\n] ",
      "[\n  2\n ] ",
      "[\n \t2\n ] ",
      "[\n\t\t2\n\t] ",
      "[\n\t \t2\n\t] ",
      "[\n\r\n2\n] ",
      "[\n \r\n2\n] ",
    ],
  },
  {
    json: "[0e+1]",
    compact: "[0e+1]",
    indents: [
      "[\n 0e+1\n]",
      "[\n  0e+1\n ]",
      "[\n \t0e+1\n ]",
      "[\n\t\t0e+1\n\t]",
      "[\n\t \t0e+1\n\t]",
      "[\n\r\n0e+1\n]",
      "[\n \r\n0e+1\n]",
    ],
  },
  {
    json: "[0e1]",
    compact: "[0e1]",
    indents: [
      "[\n 0e1\n]",
      "[\n  0e1\n ]",
      "[\n \t0e1\n ]",
      "[\n\t\t0e1\n\t]",
      "[\n\t \t0e1\n\t]",
      "[\n\r\n0e1\n]",
      "[\n \r\n0e1\n]",
    ],
  },
  {
    json: "[ 4]",
    compact: "[4]",
    indents: [
      "[\n 4\n]",
      "[\n  4\n ]",
      "[\n \t4\n ]",
      "[\n\t\t4\n\t]",
      "[\n\t \t4\n\t]",
      "[\n\r\n4\n]",
      "[\n \r\n4\n]",
    ],
  },
  {
    json: "[-0.000000000000000000000000000000000000000000000000000000000000000000000000000001]\n",
    compact: "[-0.000000000000000000000000000000000000000000000000000000000000000000000000000001]",
    indents: [
      "[\n -0.000000000000000000000000000000000000000000000000000000000000000000000000000001\n]\n",
      "[\n  -0.000000000000000000000000000000000000000000000000000000000000000000000000000001\n ]\n",
      "[\n \t-0.000000000000000000000000000000000000000000000000000000000000000000000000000001\n ]\n",
      "[\n\t\t-0.000000000000000000000000000000000000000000000000000000000000000000000000000001\n\t]\n",
      "[\n\t \t-0.000000000000000000000000000000000000000000000000000000000000000000000000000001\n\t]\n",
      "[\n\r\n-0.000000000000000000000000000000000000000000000000000000000000000000000000000001\n]\n",
      "[\n \r\n-0.000000000000000000000000000000000000000000000000000000000000000000000000000001\n]\n",
    ],
  },
  {
    json: "[20e1]",
    compact: "[20e1]",
    indents: [
      "[\n 20e1\n]",
      "[\n  20e1\n ]",
      "[\n \t20e1\n ]",
      "[\n\t\t20e1\n\t]",
      "[\n\t \t20e1\n\t]",
      "[\n\r\n20e1\n]",
      "[\n \r\n20e1\n]",
    ],
  },
  {
    json: "[123e65]",
    compact: "[123e65]",
    indents: [
      "[\n 123e65\n]",
      "[\n  123e65\n ]",
      "[\n \t123e65\n ]",
      "[\n\t\t123e65\n\t]",
      "[\n\t \t123e65\n\t]",
      "[\n\r\n123e65\n]",
      "[\n \r\n123e65\n]",
    ],
  },
  {
    json: "[-0]",
    compact: "[-0]",
    indents: [
      "[\n -0\n]",
      "[\n  -0\n ]",
      "[\n \t-0\n ]",
      "[\n\t\t-0\n\t]",
      "[\n\t \t-0\n\t]",
      "[\n\r\n-0\n]",
      "[\n \r\n-0\n]",
    ],
  },
  {
    json: "[-123]",
    compact: "[-123]",
    indents: [
      "[\n -123\n]",
      "[\n  -123\n ]",
      "[\n \t-123\n ]",
      "[\n\t\t-123\n\t]",
      "[\n\t \t-123\n\t]",
      "[\n\r\n-123\n]",
      "[\n \r\n-123\n]",
    ],
  },
  {
    json: "[-1]",
    compact: "[-1]",
    indents: [
      "[\n -1\n]",
      "[\n  -1\n ]",
      "[\n \t-1\n ]",
      "[\n\t\t-1\n\t]",
      "[\n\t \t-1\n\t]",
      "[\n\r\n-1\n]",
      "[\n \r\n-1\n]",
    ],
  },
  {
    json: "[-0]",
    compact: "[-0]",
    indents: [
      "[\n -0\n]",
      "[\n  -0\n ]",
      "[\n \t-0\n ]",
      "[\n\t\t-0\n\t]",
      "[\n\t \t-0\n\t]",
      "[\n\r\n-0\n]",
      "[\n \r\n-0\n]",
    ],
  },
  {
    json: "[1E22]",
    compact: "[1E22]",
    indents: [
      "[\n 1E22\n]",
      "[\n  1E22\n ]",
      "[\n \t1E22\n ]",
      "[\n\t\t1E22\n\t]",
      "[\n\t \t1E22\n\t]",
      "[\n\r\n1E22\n]",
      "[\n \r\n1E22\n]",
    ],
  },
  {
    json: "[1E-2]",
    compact: "[1E-2]",
    indents: [
      "[\n 1E-2\n]",
      "[\n  1E-2\n ]",
      "[\n \t1E-2\n ]",
      "[\n\t\t1E-2\n\t]",
      "[\n\t \t1E-2\n\t]",
      "[\n\r\n1E-2\n]",
      "[\n \r\n1E-2\n]",
    ],
  },
  {
    json: "[1E+2]",
    compact: "[1E+2]",
    indents: [
      "[\n 1E+2\n]",
      "[\n  1E+2\n ]",
      "[\n \t1E+2\n ]",
      "[\n\t\t1E+2\n\t]",
      "[\n\t \t1E+2\n\t]",
      "[\n\r\n1E+2\n]",
      "[\n \r\n1E+2\n]",
    ],
  },
  {
    json: "[123e45]",
    compact: "[123e45]",
    indents: [
      "[\n 123e45\n]",
      "[\n  123e45\n ]",
      "[\n \t123e45\n ]",
      "[\n\t\t123e45\n\t]",
      "[\n\t \t123e45\n\t]",
      "[\n\r\n123e45\n]",
      "[\n \r\n123e45\n]",
    ],
  },
  {
    json: "[123.456e78]",
    compact: "[123.456e78]",
    indents: [
      "[\n 123.456e78\n]",
      "[\n  123.456e78\n ]",
      "[\n \t123.456e78\n ]",
      "[\n\t\t123.456e78\n\t]",
      "[\n\t \t123.456e78\n\t]",
      "[\n\r\n123.456e78\n]",
      "[\n \r\n123.456e78\n]",
    ],
  },
  {
    json: "[1e-2]",
    compact: "[1e-2]",
    indents: [
      "[\n 1e-2\n]",
      "[\n  1e-2\n ]",
      "[\n \t1e-2\n ]",
      "[\n\t\t1e-2\n\t]",
      "[\n\t \t1e-2\n\t]",
      "[\n\r\n1e-2\n]",
      "[\n \r\n1e-2\n]",
    ],
  },
  {
    json: "[1e+2]",
    compact: "[1e+2]",
    indents: [
      "[\n 1e+2\n]",
      "[\n  1e+2\n ]",
      "[\n \t1e+2\n ]",
      "[\n\t\t1e+2\n\t]",
      "[\n\t \t1e+2\n\t]",
      "[\n\r\n1e+2\n]",
      "[\n \r\n1e+2\n]",
    ],
  },
  {
    json: "[123]",
    compact: "[123]",
    indents: [
      "[\n 123\n]",
      "[\n  123\n ]",
      "[\n \t123\n ]",
      "[\n\t\t123\n\t]",
      "[\n\t \t123\n\t]",
      "[\n\r\n123\n]",
      "[\n \r\n123\n]",
    ],
  },
  {
    json: "[123.456789]",
    compact: "[123.456789]",
    indents: [
      "[\n 123.456789\n]",
      "[\n  123.456789\n ]",
      "[\n \t123.456789\n ]",
      "[\n\t\t123.456789\n\t]",
      "[\n\t \t123.456789\n\t]",
      "[\n\r\n123.456789\n]",
      "[\n \r\n123.456789\n]",
    ],
  },
  {
    json: '{"asd":"sdf"}',
    compact: '{"asd":"sdf"}',
    indents: [
      '{\n "asd": "sdf"\n}',
      '{\n  "asd": "sdf"\n }',
      '{\n \t"asd": "sdf"\n }',
      '{\n\t\t"asd": "sdf"\n\t}',
      '{\n\t \t"asd": "sdf"\n\t}',
      '{\n\r\n"asd": "sdf"\n}',
      '{\n \r\n"asd": "sdf"\n}',
    ],
  },
  {
    json: '{"a":"b","a":"b"}',
    compact: '{"a":"b","a":"b"}',
    indents: [
      '{\n "a": "b",\n "a": "b"\n}',
      '{\n  "a": "b",\n  "a": "b"\n }',
      '{\n \t"a": "b",\n \t"a": "b"\n }',
      '{\n\t\t"a": "b",\n\t\t"a": "b"\n\t}',
      '{\n\t \t"a": "b",\n\t \t"a": "b"\n\t}',
      '{\n\r\n"a": "b",\n\r\n"a": "b"\n}',
      '{\n \r\n"a": "b",\n \r\n"a": "b"\n}',
    ],
  },
  {
    json: '{"a":"b","a":"c"}',
    compact: '{"a":"b","a":"c"}',
    indents: [
      '{\n "a": "b",\n "a": "c"\n}',
      '{\n  "a": "b",\n  "a": "c"\n }',
      '{\n \t"a": "b",\n \t"a": "c"\n }',
      '{\n\t\t"a": "b",\n\t\t"a": "c"\n\t}',
      '{\n\t \t"a": "b",\n\t \t"a": "c"\n\t}',
      '{\n\r\n"a": "b",\n\r\n"a": "c"\n}',
      '{\n \r\n"a": "b",\n \r\n"a": "c"\n}',
    ],
  },
  {
    json: "{}",
    compact: "{}",
    indents: ["{}", "{}", "{}", "{}", "{}", "{}", "{}"],
  },
  {
    json: '{"":0}',
    compact: '{"":0}',
    indents: [
      '{\n "": 0\n}',
      '{\n  "": 0\n }',
      '{\n \t"": 0\n }',
      '{\n\t\t"": 0\n\t}',
      '{\n\t \t"": 0\n\t}',
      '{\n\r\n"": 0\n}',
      '{\n \r\n"": 0\n}',
    ],
  },
  {
    json: '{"foo\\u0000bar": 42}',
    compact: '{"foo\\u0000bar":42}',
    indents: [
      '{\n "foo\\u0000bar": 42\n}',
      '{\n  "foo\\u0000bar": 42\n }',
      '{\n \t"foo\\u0000bar": 42\n }',
      '{\n\t\t"foo\\u0000bar": 42\n\t}',
      '{\n\t \t"foo\\u0000bar": 42\n\t}',
      '{\n\r\n"foo\\u0000bar": 42\n}',
      '{\n \r\n"foo\\u0000bar": 42\n}',
    ],
  },
  {
    json: '{ "min": -1.0e+28, "max": 1.0e+28 }',
    compact: '{"min":-1.0e+28,"max":1.0e+28}',
    indents: [
      '{\n "min": -1.0e+28,\n "max": 1.0e+28\n}',
      '{\n  "min": -1.0e+28,\n  "max": 1.0e+28\n }',
      '{\n \t"min": -1.0e+28,\n \t"max": 1.0e+28\n }',
      '{\n\t\t"min": -1.0e+28,\n\t\t"max": 1.0e+28\n\t}',
      '{\n\t \t"min": -1.0e+28,\n\t \t"max": 1.0e+28\n\t}',
      '{\n\r\n"min": -1.0e+28,\n\r\n"max": 1.0e+28\n}',
      '{\n \r\n"min": -1.0e+28,\n \r\n"max": 1.0e+28\n}',
    ],
  },
  {
    json: '{"asd":"sdf", "dfg":"fgh"}',
    compact: '{"asd":"sdf","dfg":"fgh"}',
    indents: [
      '{\n "asd": "sdf",\n "dfg": "fgh"\n}',
      '{\n  "asd": "sdf",\n  "dfg": "fgh"\n }',
      '{\n \t"asd": "sdf",\n \t"dfg": "fgh"\n }',
      '{\n\t\t"asd": "sdf",\n\t\t"dfg": "fgh"\n\t}',
      '{\n\t \t"asd": "sdf",\n\t \t"dfg": "fgh"\n\t}',
      '{\n\r\n"asd": "sdf",\n\r\n"dfg": "fgh"\n}',
      '{\n \r\n"asd": "sdf",\n \r\n"dfg": "fgh"\n}',
    ],
  },
  {
    json: '{"x":[{"id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}], "id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}',
    compact:
      '{"x":[{"id":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}],"id":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}',
    indents: [
      '{\n "x": [\n  {\n   "id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n  }\n ],\n "id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n}',
      '{\n  "x": [\n   {\n    "id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n   }\n  ],\n  "id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n }',
      '{\n \t"x": [\n \t\t{\n \t\t\t"id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n \t\t}\n \t],\n \t"id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n }',
      '{\n\t\t"x": [\n\t\t\t{\n\t\t\t\t"id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n\t\t\t}\n\t\t],\n\t\t"id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n\t}',
      '{\n\t \t"x": [\n\t \t \t{\n\t \t \t \t"id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n\t \t \t}\n\t \t],\n\t \t"id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n\t}',
      '{\n\r\n"x": [\n\r\n\r\n{\n\r\n\r\n\r\n"id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n\r\n\r\n}\n\r\n],\n\r\n"id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n}',
      '{\n \r\n"x": [\n \r\n \r\n{\n \r\n \r\n \r\n"id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n \r\n \r\n}\n \r\n],\n \r\n"id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n}',
    ],
  },
  {
    json: '{"a":[]}',
    compact: '{"a":[]}',
    indents: [
      '{\n "a": []\n}',
      '{\n  "a": []\n }',
      '{\n \t"a": []\n }',
      '{\n\t\t"a": []\n\t}',
      '{\n\t \t"a": []\n\t}',
      '{\n\r\n"a": []\n}',
      '{\n \r\n"a": []\n}',
    ],
  },
  {
    json: '{"title":"\\u041f\\u043e\\u043b\\u0442\\u043e\\u0440\\u0430 \\u0417\\u0435\\u043c\\u043b\\u0435\\u043a\\u043e\\u043f\\u0430" }',
    compact:
      '{"title":"\\u041f\\u043e\\u043b\\u0442\\u043e\\u0440\\u0430 \\u0417\\u0435\\u043c\\u043b\\u0435\\u043a\\u043e\\u043f\\u0430"}',
    indents: [
      '{\n "title": "\\u041f\\u043e\\u043b\\u0442\\u043e\\u0440\\u0430 \\u0417\\u0435\\u043c\\u043b\\u0435\\u043a\\u043e\\u043f\\u0430"\n}',
      '{\n  "title": "\\u041f\\u043e\\u043b\\u0442\\u043e\\u0440\\u0430 \\u0417\\u0435\\u043c\\u043b\\u0435\\u043a\\u043e\\u043f\\u0430"\n }',
      '{\n \t"title": "\\u041f\\u043e\\u043b\\u0442\\u043e\\u0440\\u0430 \\u0417\\u0435\\u043c\\u043b\\u0435\\u043a\\u043e\\u043f\\u0430"\n }',
      '{\n\t\t"title": "\\u041f\\u043e\\u043b\\u0442\\u043e\\u0440\\u0430 \\u0417\\u0435\\u043c\\u043b\\u0435\\u043a\\u043e\\u043f\\u0430"\n\t}',
      '{\n\t \t"title": "\\u041f\\u043e\\u043b\\u0442\\u043e\\u0440\\u0430 \\u0417\\u0435\\u043c\\u043b\\u0435\\u043a\\u043e\\u043f\\u0430"\n\t}',
      '{\n\r\n"title": "\\u041f\\u043e\\u043b\\u0442\\u043e\\u0440\\u0430 \\u0417\\u0435\\u043c\\u043b\\u0435\\u043a\\u043e\\u043f\\u0430"\n}',
      '{\n \r\n"title": "\\u041f\\u043e\\u043b\\u0442\\u043e\\u0440\\u0430 \\u0417\\u0435\\u043c\\u043b\\u0435\\u043a\\u043e\\u043f\\u0430"\n}',
    ],
  },
  {
    json: '{\n"a": "b"\n}',
    compact: '{"a":"b"}',
    indents: [
      '{\n "a": "b"\n}',
      '{\n  "a": "b"\n }',
      '{\n \t"a": "b"\n }',
      '{\n\t\t"a": "b"\n\t}',
      '{\n\t \t"a": "b"\n\t}',
      '{\n\r\n"a": "b"\n}',
      '{\n \r\n"a": "b"\n}',
    ],
  },
  {
    json: '["\\u0060\\u012a\\u12AB"]',
    compact: '["\\u0060\\u012a\\u12AB"]',
    indents: [
      '[\n "\\u0060\\u012a\\u12AB"\n]',
      '[\n  "\\u0060\\u012a\\u12AB"\n ]',
      '[\n \t"\\u0060\\u012a\\u12AB"\n ]',
      '[\n\t\t"\\u0060\\u012a\\u12AB"\n\t]',
      '[\n\t \t"\\u0060\\u012a\\u12AB"\n\t]',
      '[\n\r\n"\\u0060\\u012a\\u12AB"\n]',
      '[\n \r\n"\\u0060\\u012a\\u12AB"\n]',
    ],
  },
  {
    json: '["\\uD801\\udc37"]',
    compact: '["\\uD801\\udc37"]',
    indents: [
      '[\n "\\uD801\\udc37"\n]',
      '[\n  "\\uD801\\udc37"\n ]',
      '[\n \t"\\uD801\\udc37"\n ]',
      '[\n\t\t"\\uD801\\udc37"\n\t]',
      '[\n\t \t"\\uD801\\udc37"\n\t]',
      '[\n\r\n"\\uD801\\udc37"\n]',
      '[\n \r\n"\\uD801\\udc37"\n]',
    ],
  },
  {
    json: '["\\ud83d\\ude39\\ud83d\\udc8d"]',
    compact: '["\\ud83d\\ude39\\ud83d\\udc8d"]',
    indents: [
      '[\n "\\ud83d\\ude39\\ud83d\\udc8d"\n]',
      '[\n  "\\ud83d\\ude39\\ud83d\\udc8d"\n ]',
      '[\n \t"\\ud83d\\ude39\\ud83d\\udc8d"\n ]',
      '[\n\t\t"\\ud83d\\ude39\\ud83d\\udc8d"\n\t]',
      '[\n\t \t"\\ud83d\\ude39\\ud83d\\udc8d"\n\t]',
      '[\n\r\n"\\ud83d\\ude39\\ud83d\\udc8d"\n]',
      '[\n \r\n"\\ud83d\\ude39\\ud83d\\udc8d"\n]',
    ],
  },
  {
    json: '["\\"\\\\\\/\\b\\f\\n\\r\\t"]',
    compact: '["\\"\\\\\\/\\b\\f\\n\\r\\t"]',
    indents: [
      '[\n "\\"\\\\\\/\\b\\f\\n\\r\\t"\n]',
      '[\n  "\\"\\\\\\/\\b\\f\\n\\r\\t"\n ]',
      '[\n \t"\\"\\\\\\/\\b\\f\\n\\r\\t"\n ]',
      '[\n\t\t"\\"\\\\\\/\\b\\f\\n\\r\\t"\n\t]',
      '[\n\t \t"\\"\\\\\\/\\b\\f\\n\\r\\t"\n\t]',
      '[\n\r\n"\\"\\\\\\/\\b\\f\\n\\r\\t"\n]',
      '[\n \r\n"\\"\\\\\\/\\b\\f\\n\\r\\t"\n]',
    ],
  },
  {
    json: '["\\\\u0000"]',
    compact: '["\\\\u0000"]',
    indents: [
      '[\n "\\\\u0000"\n]',
      '[\n  "\\\\u0000"\n ]',
      '[\n \t"\\\\u0000"\n ]',
      '[\n\t\t"\\\\u0000"\n\t]',
      '[\n\t \t"\\\\u0000"\n\t]',
      '[\n\r\n"\\\\u0000"\n]',
      '[\n \r\n"\\\\u0000"\n]',
    ],
  },
  {
    json: '["\\""]',
    compact: '["\\""]',
    indents: [
      '[\n "\\""\n]',
      '[\n  "\\""\n ]',
      '[\n \t"\\""\n ]',
      '[\n\t\t"\\""\n\t]',
      '[\n\t \t"\\""\n\t]',
      '[\n\r\n"\\""\n]',
      '[\n \r\n"\\""\n]',
    ],
  },
  {
    json: '["a/*b*/c/*d//e"]',
    compact: '["a/*b*/c/*d//e"]',
    indents: [
      '[\n "a/*b*/c/*d//e"\n]',
      '[\n  "a/*b*/c/*d//e"\n ]',
      '[\n \t"a/*b*/c/*d//e"\n ]',
      '[\n\t\t"a/*b*/c/*d//e"\n\t]',
      '[\n\t \t"a/*b*/c/*d//e"\n\t]',
      '[\n\r\n"a/*b*/c/*d//e"\n]',
      '[\n \r\n"a/*b*/c/*d//e"\n]',
    ],
  },
  {
    json: '["\\\\a"]',
    compact: '["\\\\a"]',
    indents: [
      '[\n "\\\\a"\n]',
      '[\n  "\\\\a"\n ]',
      '[\n \t"\\\\a"\n ]',
      '[\n\t\t"\\\\a"\n\t]',
      '[\n\t \t"\\\\a"\n\t]',
      '[\n\r\n"\\\\a"\n]',
      '[\n \r\n"\\\\a"\n]',
    ],
  },
  {
    json: '["\\\\n"]',
    compact: '["\\\\n"]',
    indents: [
      '[\n "\\\\n"\n]',
      '[\n  "\\\\n"\n ]',
      '[\n \t"\\\\n"\n ]',
      '[\n\t\t"\\\\n"\n\t]',
      '[\n\t \t"\\\\n"\n\t]',
      '[\n\r\n"\\\\n"\n]',
      '[\n \r\n"\\\\n"\n]',
    ],
  },
  {
    json: '["\\u0012"]',
    compact: '["\\u0012"]',
    indents: [
      '[\n "\\u0012"\n]',
      '[\n  "\\u0012"\n ]',
      '[\n \t"\\u0012"\n ]',
      '[\n\t\t"\\u0012"\n\t]',
      '[\n\t \t"\\u0012"\n\t]',
      '[\n\r\n"\\u0012"\n]',
      '[\n \r\n"\\u0012"\n]',
    ],
  },
  {
    json: '["\\uFFFF"]',
    compact: '["\\uFFFF"]',
    indents: [
      '[\n "\\uFFFF"\n]',
      '[\n  "\\uFFFF"\n ]',
      '[\n \t"\\uFFFF"\n ]',
      '[\n\t\t"\\uFFFF"\n\t]',
      '[\n\t \t"\\uFFFF"\n\t]',
      '[\n\r\n"\\uFFFF"\n]',
      '[\n \r\n"\\uFFFF"\n]',
    ],
  },
  {
    json: '["asd"]',
    compact: '["asd"]',
    indents: [
      '[\n "asd"\n]',
      '[\n  "asd"\n ]',
      '[\n \t"asd"\n ]',
      '[\n\t\t"asd"\n\t]',
      '[\n\t \t"asd"\n\t]',
      '[\n\r\n"asd"\n]',
      '[\n \r\n"asd"\n]',
    ],
  },
  {
    json: '[ "asd"]',
    compact: '["asd"]',
    indents: [
      '[\n "asd"\n]',
      '[\n  "asd"\n ]',
      '[\n \t"asd"\n ]',
      '[\n\t\t"asd"\n\t]',
      '[\n\t \t"asd"\n\t]',
      '[\n\r\n"asd"\n]',
      '[\n \r\n"asd"\n]',
    ],
  },
  {
    json: '["\\uDBFF\\uDFFF"]',
    compact: '["\\uDBFF\\uDFFF"]',
    indents: [
      '[\n "\\uDBFF\\uDFFF"\n]',
      '[\n  "\\uDBFF\\uDFFF"\n ]',
      '[\n \t"\\uDBFF\\uDFFF"\n ]',
      '[\n\t\t"\\uDBFF\\uDFFF"\n\t]',
      '[\n\t \t"\\uDBFF\\uDFFF"\n\t]',
      '[\n\r\n"\\uDBFF\\uDFFF"\n]',
      '[\n \r\n"\\uDBFF\\uDFFF"\n]',
    ],
  },
  {
    json: '["new\\u00A0line"]',
    compact: '["new\\u00A0line"]',
    indents: [
      '[\n "new\\u00A0line"\n]',
      '[\n  "new\\u00A0line"\n ]',
      '[\n \t"new\\u00A0line"\n ]',
      '[\n\t\t"new\\u00A0line"\n\t]',
      '[\n\t \t"new\\u00A0line"\n\t]',
      '[\n\r\n"new\\u00A0line"\n]',
      '[\n \r\n"new\\u00A0line"\n]',
    ],
  },
  {
    json: '["􏿿"]',
    compact: '["􏿿"]',
    indents: [
      '[\n "􏿿"\n]',
      '[\n  "􏿿"\n ]',
      '[\n \t"􏿿"\n ]',
      '[\n\t\t"􏿿"\n\t]',
      '[\n\t \t"􏿿"\n\t]',
      '[\n\r\n"􏿿"\n]',
      '[\n \r\n"􏿿"\n]',
    ],
  },
  {
    json: '["￿"]',
    compact: '["￿"]',
    indents: [
      '[\n "￿"\n]',
      '[\n  "￿"\n ]',
      '[\n \t"￿"\n ]',
      '[\n\t\t"￿"\n\t]',
      '[\n\t \t"￿"\n\t]',
      '[\n\r\n"￿"\n]',
      '[\n \r\n"￿"\n]',
    ],
  },
  {
    json: '["\\u0000"]',
    compact: '["\\u0000"]',
    indents: [
      '[\n "\\u0000"\n]',
      '[\n  "\\u0000"\n ]',
      '[\n \t"\\u0000"\n ]',
      '[\n\t\t"\\u0000"\n\t]',
      '[\n\t \t"\\u0000"\n\t]',
      '[\n\r\n"\\u0000"\n]',
      '[\n \r\n"\\u0000"\n]',
    ],
  },
  {
    json: '["\\u002c"]',
    compact: '["\\u002c"]',
    indents: [
      '[\n "\\u002c"\n]',
      '[\n  "\\u002c"\n ]',
      '[\n \t"\\u002c"\n ]',
      '[\n\t\t"\\u002c"\n\t]',
      '[\n\t \t"\\u002c"\n\t]',
      '[\n\r\n"\\u002c"\n]',
      '[\n \r\n"\\u002c"\n]',
    ],
  },
  {
    json: '["π"]',
    compact: '["π"]',
    indents: [
      '[\n "π"\n]',
      '[\n  "π"\n ]',
      '[\n \t"π"\n ]',
      '[\n\t\t"π"\n\t]',
      '[\n\t \t"π"\n\t]',
      '[\n\r\n"π"\n]',
      '[\n \r\n"π"\n]',
    ],
  },
  {
    json: '["𛿿"]',
    compact: '["𛿿"]',
    indents: [
      '[\n "𛿿"\n]',
      '[\n  "𛿿"\n ]',
      '[\n \t"𛿿"\n ]',
      '[\n\t\t"𛿿"\n\t]',
      '[\n\t \t"𛿿"\n\t]',
      '[\n\r\n"𛿿"\n]',
      '[\n \r\n"𛿿"\n]',
    ],
  },
  {
    json: '["asd "]',
    compact: '["asd "]',
    indents: [
      '[\n "asd "\n]',
      '[\n  "asd "\n ]',
      '[\n \t"asd "\n ]',
      '[\n\t\t"asd "\n\t]',
      '[\n\t \t"asd "\n\t]',
      '[\n\r\n"asd "\n]',
      '[\n \r\n"asd "\n]',
    ],
  },
  {
    json: '" "',
    compact: '" "',
    indents: ['" "', '" "', '" "', '" "', '" "', '" "', '" "'],
  },
  {
    json: '["\\uD834\\uDd1e"]',
    compact: '["\\uD834\\uDd1e"]',
    indents: [
      '[\n "\\uD834\\uDd1e"\n]',
      '[\n  "\\uD834\\uDd1e"\n ]',
      '[\n \t"\\uD834\\uDd1e"\n ]',
      '[\n\t\t"\\uD834\\uDd1e"\n\t]',
      '[\n\t \t"\\uD834\\uDd1e"\n\t]',
      '[\n\r\n"\\uD834\\uDd1e"\n]',
      '[\n \r\n"\\uD834\\uDd1e"\n]',
    ],
  },
  {
    json: '["\\u0821"]',
    compact: '["\\u0821"]',
    indents: [
      '[\n "\\u0821"\n]',
      '[\n  "\\u0821"\n ]',
      '[\n \t"\\u0821"\n ]',
      '[\n\t\t"\\u0821"\n\t]',
      '[\n\t \t"\\u0821"\n\t]',
      '[\n\r\n"\\u0821"\n]',
      '[\n \r\n"\\u0821"\n]',
    ],
  },
  {
    json: '["\\u0123"]',
    compact: '["\\u0123"]',
    indents: [
      '[\n "\\u0123"\n]',
      '[\n  "\\u0123"\n ]',
      '[\n \t"\\u0123"\n ]',
      '[\n\t\t"\\u0123"\n\t]',
      '[\n\t \t"\\u0123"\n\t]',
      '[\n\r\n"\\u0123"\n]',
      '[\n \r\n"\\u0123"\n]',
    ],
  },
  {
    json: '[" "]',
    compact: '[" "]',
    indents: [
      '[\n " "\n]',
      '[\n  " "\n ]',
      '[\n \t" "\n ]',
      '[\n\t\t" "\n\t]',
      '[\n\t \t" "\n\t]',
      '[\n\r\n" "\n]',
      '[\n \r\n" "\n]',
    ],
  },
  {
    json: '[" "]',
    compact: '[" "]',
    indents: [
      '[\n " "\n]',
      '[\n  " "\n ]',
      '[\n \t" "\n ]',
      '[\n\t\t" "\n\t]',
      '[\n\t \t" "\n\t]',
      '[\n\r\n" "\n]',
      '[\n \r\n" "\n]',
    ],
  },
  {
    json: '["new\\u000Aline"]',
    compact: '["new\\u000Aline"]',
    indents: [
      '[\n "new\\u000Aline"\n]',
      '[\n  "new\\u000Aline"\n ]',
      '[\n \t"new\\u000Aline"\n ]',
      '[\n\t\t"new\\u000Aline"\n\t]',
      '[\n\t \t"new\\u000Aline"\n\t]',
      '[\n\r\n"new\\u000Aline"\n]',
      '[\n \r\n"new\\u000Aline"\n]',
    ],
  },
  {
    json: '["\\u0061\\u30af\\u30EA\\u30b9"]',
    compact: '["\\u0061\\u30af\\u30EA\\u30b9"]',
    indents: [
      '[\n "\\u0061\\u30af\\u30EA\\u30b9"\n]',
      '[\n  "\\u0061\\u30af\\u30EA\\u30b9"\n ]',
      '[\n \t"\\u0061\\u30af\\u30EA\\u30b9"\n ]',
      '[\n\t\t"\\u0061\\u30af\\u30EA\\u30b9"\n\t]',
      '[\n\t \t"\\u0061\\u30af\\u30EA\\u30b9"\n\t]',
      '[\n\r\n"\\u0061\\u30af\\u30EA\\u30b9"\n]',
      '[\n \r\n"\\u0061\\u30af\\u30EA\\u30b9"\n]',
    ],
  },
  {
    json: '[""]',
    compact: '[""]',
    indents: [
      '[\n ""\n]',
      '[\n  ""\n ]',
      '[\n \t""\n ]',
      '[\n\t\t""\n\t]',
      '[\n\t \t""\n\t]',
      '[\n\r\n""\n]',
      '[\n \r\n""\n]',
    ],
  },
  {
    json: '["⍂㈴⍂"]',
    compact: '["⍂㈴⍂"]',
    indents: [
      '[\n "⍂㈴⍂"\n]',
      '[\n  "⍂㈴⍂"\n ]',
      '[\n \t"⍂㈴⍂"\n ]',
      '[\n\t\t"⍂㈴⍂"\n\t]',
      '[\n\t \t"⍂㈴⍂"\n\t]',
      '[\n\r\n"⍂㈴⍂"\n]',
      '[\n \r\n"⍂㈴⍂"\n]',
    ],
  },
  {
    json: '["\\u005C"]',
    compact: '["\\u005C"]',
    indents: [
      '[\n "\\u005C"\n]',
      '[\n  "\\u005C"\n ]',
      '[\n \t"\\u005C"\n ]',
      '[\n\t\t"\\u005C"\n\t]',
      '[\n\t \t"\\u005C"\n\t]',
      '[\n\r\n"\\u005C"\n]',
      '[\n \r\n"\\u005C"\n]',
    ],
  },
  {
    json: '["\\u0022"]',
    compact: '["\\u0022"]',
    indents: [
      '[\n "\\u0022"\n]',
      '[\n  "\\u0022"\n ]',
      '[\n \t"\\u0022"\n ]',
      '[\n\t\t"\\u0022"\n\t]',
      '[\n\t \t"\\u0022"\n\t]',
      '[\n\r\n"\\u0022"\n]',
      '[\n \r\n"\\u0022"\n]',
    ],
  },
  {
    json: '["\\uA66D"]',
    compact: '["\\uA66D"]',
    indents: [
      '[\n "\\uA66D"\n]',
      '[\n  "\\uA66D"\n ]',
      '[\n \t"\\uA66D"\n ]',
      '[\n\t\t"\\uA66D"\n\t]',
      '[\n\t \t"\\uA66D"\n\t]',
      '[\n\r\n"\\uA66D"\n]',
      '[\n \r\n"\\uA66D"\n]',
    ],
  },
  {
    json: '["\\uDBFF\\uDFFE"]',
    compact: '["\\uDBFF\\uDFFE"]',
    indents: [
      '[\n "\\uDBFF\\uDFFE"\n]',
      '[\n  "\\uDBFF\\uDFFE"\n ]',
      '[\n \t"\\uDBFF\\uDFFE"\n ]',
      '[\n\t\t"\\uDBFF\\uDFFE"\n\t]',
      '[\n\t \t"\\uDBFF\\uDFFE"\n\t]',
      '[\n\r\n"\\uDBFF\\uDFFE"\n]',
      '[\n \r\n"\\uDBFF\\uDFFE"\n]',
    ],
  },
  {
    json: '["\\uD83F\\uDFFE"]',
    compact: '["\\uD83F\\uDFFE"]',
    indents: [
      '[\n "\\uD83F\\uDFFE"\n]',
      '[\n  "\\uD83F\\uDFFE"\n ]',
      '[\n \t"\\uD83F\\uDFFE"\n ]',
      '[\n\t\t"\\uD83F\\uDFFE"\n\t]',
      '[\n\t \t"\\uD83F\\uDFFE"\n\t]',
      '[\n\r\n"\\uD83F\\uDFFE"\n]',
      '[\n \r\n"\\uD83F\\uDFFE"\n]',
    ],
  },
  {
    json: '["\\u200B"]',
    compact: '["\\u200B"]',
    indents: [
      '[\n "\\u200B"\n]',
      '[\n  "\\u200B"\n ]',
      '[\n \t"\\u200B"\n ]',
      '[\n\t\t"\\u200B"\n\t]',
      '[\n\t \t"\\u200B"\n\t]',
      '[\n\r\n"\\u200B"\n]',
      '[\n \r\n"\\u200B"\n]',
    ],
  },
  {
    json: '["\\u2064"]',
    compact: '["\\u2064"]',
    indents: [
      '[\n "\\u2064"\n]',
      '[\n  "\\u2064"\n ]',
      '[\n \t"\\u2064"\n ]',
      '[\n\t\t"\\u2064"\n\t]',
      '[\n\t \t"\\u2064"\n\t]',
      '[\n\r\n"\\u2064"\n]',
      '[\n \r\n"\\u2064"\n]',
    ],
  },
  {
    json: '["\\uFDD0"]',
    compact: '["\\uFDD0"]',
    indents: [
      '[\n "\\uFDD0"\n]',
      '[\n  "\\uFDD0"\n ]',
      '[\n \t"\\uFDD0"\n ]',
      '[\n\t\t"\\uFDD0"\n\t]',
      '[\n\t \t"\\uFDD0"\n\t]',
      '[\n\r\n"\\uFDD0"\n]',
      '[\n \r\n"\\uFDD0"\n]',
    ],
  },
  {
    json: '["\\uFFFE"]',
    compact: '["\\uFFFE"]',
    indents: [
      '[\n "\\uFFFE"\n]',
      '[\n  "\\uFFFE"\n ]',
      '[\n \t"\\uFFFE"\n ]',
      '[\n\t\t"\\uFFFE"\n\t]',
      '[\n\t \t"\\uFFFE"\n\t]',
      '[\n\r\n"\\uFFFE"\n]',
      '[\n \r\n"\\uFFFE"\n]',
    ],
  },
  {
    json: '["€𝄞"]',
    compact: '["€𝄞"]',
    indents: [
      '[\n "€𝄞"\n]',
      '[\n  "€𝄞"\n ]',
      '[\n \t"€𝄞"\n ]',
      '[\n\t\t"€𝄞"\n\t]',
      '[\n\t \t"€𝄞"\n\t]',
      '[\n\r\n"€𝄞"\n]',
      '[\n \r\n"€𝄞"\n]',
    ],
  },
  {
    json: '["aa"]',
    compact: '["aa"]',
    indents: [
      '[\n "aa"\n]',
      '[\n  "aa"\n ]',
      '[\n \t"aa"\n ]',
      '[\n\t\t"aa"\n\t]',
      '[\n\t \t"aa"\n\t]',
      '[\n\r\n"aa"\n]',
      '[\n \r\n"aa"\n]',
    ],
  },
  {
    json: "false",
    compact: "false",
    indents: ["false", "false", "false", "false", "false", "false", "false"],
  },
  {
    json: "42",
    compact: "42",
    indents: ["42", "42", "42", "42", "42", "42", "42"],
  },
  {
    json: "-0.1",
    compact: "-0.1",
    indents: ["-0.1", "-0.1", "-0.1", "-0.1", "-0.1", "-0.1", "-0.1"],
  },
  {
    json: "null",
    compact: "null",
    indents: ["null", "null", "null", "null", "null", "null", "null"],
  },
  {
    json: '"asd"',
    compact: '"asd"',
    indents: ['"asd"', '"asd"', '"asd"', '"asd"', '"asd"', '"asd"', '"asd"'],
  },
  {
    json: "true",
    compact: "true",
    indents: ["true", "true", "true", "true", "true", "true", "true"],
  },
  {
    json: '""',
    compact: '""',
    indents: ['""', '""', '""', '""', '""', '""', '""'],
  },
  {
    json: '["a"]\n',
    compact: '["a"]',
    indents: [
      '[\n "a"\n]\n',
      '[\n  "a"\n ]\n',
      '[\n \t"a"\n ]\n',
      '[\n\t\t"a"\n\t]\n',
      '[\n\t \t"a"\n\t]\n',
      '[\n\r\n"a"\n]\n',
      '[\n \r\n"a"\n]\n',
    ],
  },
  {
    json: "[true]",
    compact: "[true]",
    indents: [
      "[\n true\n]",
      "[\n  true\n ]",
      "[\n \ttrue\n ]",
      "[\n\t\ttrue\n\t]",
      "[\n\t \ttrue\n\t]",
      "[\n\r\ntrue\n]",
      "[\n \r\ntrue\n]",
    ],
  },
  {
    json: " [] ",
    compact: "[]",
    indents: ["[] ", "[] ", "[] ", "[] ", "[] ", "[] ", "[] "],
  },
];

// Truncate inputs at each possible index and test if decoder parses
// the truncated part successfully.
function testTruncating(jsonBytes: Uint8Array): void {
  const p = new parserState(0);
  for (let i = 1; i <= jsonBytes.length; i++) {
    const b = new Bytes(jsonBytes.subarray(0, i));
    b.trimRWS();
    p.reset();
    p.consumeAny(b.b, [], 0);
    expect(p.ib).toBe(b.length);
  }
}

describe("TestConsumeString", () => {
  const tCases: [name: string, data: Uint8Array, expected: number][] = [
    ["ascii string", raw(`foo"`), 4],
    ["utf-8 string one char", raw(`ß"`), 3],
    ["utf-8 string multiple chars", raw(`ßßßß"`), 9],
    ["empty string", raw(``), 0],
    ["non-ending ascii string", raw(`a`), 0],
    ["non-ending utf-8 string", raw(`ß`), 0],
    ["escaped ascii string", g`\\b a\"`, 5],
    ["escaped utf-8 string", g`\\b ß\"`, 6],
  ];

  for (const [name, data, expected] of tCases) {
    test(name, () => {
      const p = new parserState(0);
      expect(p.consumeString(data)).toBe(expected);
    });
  }
});

describe("TestConsumeNumber", () => {
  const tCases: [data: string, expected: number][] = [
    [`123`, 3],
    [`123.1`, 5],
    [`123.`, 4],
    [`.123`, 4],
    [`.`, 0],
    [`..`, 0],
    [`e`, 0],
    [`1e1`, 3],
    [`1.1e1`, 5],
    [`.1e1`, 4],
    ["", 0],
    [`"NaN"`, 0],
    [`"Infinity"`, 0],
    [`"-Infinity"`, 0],
    [".0", 2],
    ["0", 1],
    ["-0", 2],
    ["+0", 0],
    ["1", 1],
    ["-1", 2],
    ["00", 2],
    ["-00", 3],
    ["01", 2],
    ["-01", 3],
    ["0i", 1],
    ["-0i", 2],
    ["0f", 1],
    ["-0f", 2],
    ["9876543210", 10],
    ["-9876543210", 11],
    ["9876543210x", 10],
    ["-9876543210x", 11],
    [" 9876543210", 0],
    ["- 9876543210", 0],
    ["9876543210".repeat(1000), 10000],
    ["-" + "9876543210".repeat(1000), 1 + 10000],
    ["0.", 2],
    ["-0.", 3],
    ["0e", 0],
    ["-0e", 0],
    ["0E", 0],
    ["-0E", 0],
    ["0.0", 3],
    ["-0.0", 4],
    ["0e0", 3],
    ["-0e0", 4],
    ["0E0", 3],
    ["-0E0", 4],
    ["0.0123456789", 12],
    ["-0.0123456789", 13],
    ["1.f", 2],
    ["-1.f", 3],
    ["1.e", 0],
    ["-1.e", 0],
    ["1e0", 3],
    ["-1e0", 4],
    ["1E0", 3],
    ["-1E0", 4],
    ["1Ex", 0],
    ["-1Ex", 0],
    ["1e-0", 4],
    ["-1e-0", 5],
    ["1e+0", 4],
    ["-1e+0", 5],
    ["1E-0", 4],
    ["-1E-0", 5],
    ["1E+0", 4],
    ["-1E+0", 5],
    ["1E+00500", 8],
    ["-1E+00500", 9],
    ["1E+00500x", 8],
    ["-1E+00500x", 9],
    ["9876543210.0123456789e+01234589x", 31],
    ["-9876543210.0123456789e+01234589x", 32],
    ["1_000_000", 1],
    ["0x12ef", 1],
    ["0x1p-2", 1],
  ];

  const p = new parserState(0);
  for (const [data, expected] of tCases) {
    // Go truncates names longer than 10 bytes; the inputs are ASCII.
    const tname = data.length > 10 ? data.slice(0, 10) + "..." : data;
    test(tname, () => {
      expect(p.consumeNumber(raw(data))).toBe(expected);
    });
  }
});

describe("TestConsumeArray", () => {
  const tCases: [name: string, data: Uint8Array, expected: number][] = [
    ["empty array", raw(`]`), 1],
    ["empty array spaces", raw(` ]`), 2],
    ["one int array", raw(`1]`), 2],
    ["one int array spaces", raw(` 1 ]`), 4],
    ["two ints array", raw(`1,2]`), 4],
    ["two ints array spaces", raw(` 1 , 2 ]`), 8],
    ["everything array", raw(`[], {}, true, false, null, 1, "abc"]`), 36],
    ["everything array v2", raw(`[1,2,3], {"a":"b"}, true, false, null, 1, "abc"]`), 48],
    ['escaped "', raw(String.raw`"\""]`), 5],
    ["hex", raw(String.raw`"ꙭ"]`), 9],
    ["unfinished string", raw(String.raw`"\uFFF`), 0],
  ];

  const p = new parserState(0);
  for (const [name, data, expected] of tCases) {
    test(name, () => {
      expect(p.consumeArray(data, [], 1)).toBe(expected);
    });
  }
});

describe("TestQueryObject", () => {
  const tCases: { name: string; json: Uint8Array; query: query; expectedFind: boolean }[] = [
    {
      name: "empty path",
      json: raw(String.raw`{"foo": {"bar": "baz"}}`),
      query: { SearchPath: [raw("")], SearchVals: [] },
      expectedFind: false,
    },
    {
      name: "path not matching after",
      json: raw(String.raw`{"foo": {"bar": "baz"}}`),
      query: { SearchPath: [raw("fool")], SearchVals: [] },
      expectedFind: false,
    },
    {
      name: "path not matching before",
      json: raw(String.raw`{"foo": {"bar": "baz"}}`),
      query: { SearchPath: [raw("afoo")], SearchVals: [] },
      expectedFind: false,
    },
    {
      name: "empty segment followed by valid segment",
      json: raw(String.raw`{"foo": {"bar": "baz"}}`),
      query: { SearchPath: [raw(""), raw("foo")], SearchVals: [] },
      expectedFind: false,
    },
    {
      name: "inversed segments",
      json: raw(String.raw`{"foo": {"bar": "baz"}}`),
      query: { SearchPath: [raw("bar"), raw("foo")], SearchVals: [] },
      expectedFind: false,
    },
    {
      name: "foo is value, not path",
      json: raw(String.raw`{"foo": {"bar": "foo"}}`),
      query: { SearchPath: [raw("bar"), raw("foo")], SearchVals: [] },
      expectedFind: false,
    },
    {
      name: "not matching because it's array",
      json: raw(String.raw`[{"foo": {"bar": "baz"}}]`),
      query: { SearchPath: [raw("foo"), raw("bar")], SearchVals: [] },
      expectedFind: false,
    },
    {
      name: "match without value",
      json: raw(String.raw`{"foo": {"bar": "baz"}}`),
      query: { SearchPath: [raw("foo"), raw("bar")], SearchVals: [] },
      expectedFind: true,
    },
    {
      name: "match with value",
      json: raw(String.raw`{"foo": {"bar": "baz"}}`),
      query: { SearchPath: [raw("foo"), raw("bar")], SearchVals: [raw(`"baz"`)] },
      expectedFind: true,
    },
    {
      name: "no match because path is offset with one foo",
      json: raw(String.raw`{"foo": {"foo": {"bar": "baz"}}}`),
      query: { SearchPath: [raw("foo"), raw("bar")], SearchVals: [raw(`"baz"`)] },
      expectedFind: false,
    },
  ];

  for (const tt of tCases) {
    test(tt.name, () => {
      const p = new parserState(0);
      p.consumeAny(tt.json, [tt.query], 0);
      expect(p.querySatisfied).toBe(tt.expectedFind);
    });
  }
});

describe("TestConsumeObject", () => {
  const tCases: [name: string, data: Uint8Array, expected: number][] = [
    ["empty object", raw(`}`), 1],
    ["object", raw(`"a":"b"}`), 8],
    ["panic found with fuzz", g`\"\":0`, 0],
  ];

  const p = new parserState(0);
  for (const [name, data, expected] of tCases) {
    test(name, () => {
      expect(p.consumeObject(data, [], 1)).toBe(expected);
    });
  }
});

describe("TestConsumeConst", () => {
  const tCases: [b: string, cnst: string, expect: number, inspect: number][] = [
    ["", "", 0, 0],
    ["", "true", 0, 0],
    ["true", "", 0, 0],
    ["t", "true", 0, 1],
    ["tr", "true", 0, 2],
    ["tru", "true", 0, 3],
    ["true", "true", 4, 4],
    ["truex", "true", 4, 4],
  ];

  for (const [b, cnst, want, inspect] of tCases) {
    test(b + " -- " + cnst, () => {
      const p = new parserState(0);
      expect(p.consumeConst(raw(b), raw(cnst))).toBe(want);
      expect(p.ib).toBe(inspect);
    });
  }
});

test("TestPositives", () => {
  for (const tt of positives) {
    testTruncating(tt.json);
  }
});

test("TestPositivesCompacted", () => {
  const stdlib = positives.filter((tt) => tt.stdlib).map((tt) => bytesToText(tt.json));
  expect(stdlib).toEqual(stdlibGolden.map((gd) => gd.json));
  for (const gd of stdlibGolden) {
    testTruncating(textToBytes(gd.compact));
  }
});

test("TestPositivesIndented", () => {
  for (const gd of stdlibGolden) {
    for (const indent of gd.indents) {
      testTruncating(textToBytes(indent));
    }
  }
});

describe("TestNegatives", () => {
  const p = new parserState(0);
  for (const [name, json, expectParse, expectInspect] of negatives) {
    test(name, () => {
      p.reset();
      expect(p.consumeAny(json, [], 0)).toBe(expectParse);
      expect(p.ib).toBe(expectInspect);
    });
  }
});

describe("TestMaxRecursion", () => {
  // Go names subtests with the first 10 bytes of the input.
  const tCases: [
    name: string,
    maxRecursion: number,
    input: Uint8Array,
    expectParsed: number,
    expectInspected: number,
  ][] = [
    ["[]", 0, raw(`[]`), 2, 2],
    ["[[[]]]", 0, raw(`[[[]]]`), 6, 6],
    ["[".repeat(10) + "...", 0, raw("[".repeat(10000) + "]".repeat(10000)), 20000, 20000],
    ["[[[[[]]]]]", 3, raw(`[[[[[]]]]]`), 1, 4], // max recursion is 3 so we need to inspect 4 opening brackets
  ];
  for (const [name, maxRecursion, input, expectParsed, expectInspected] of tCases) {
    test(name, () => {
      const p = new parserState(maxRecursion);
      expect(p.consumeAny(input, [], 0)).toBe(expectParsed);
      expect(p.ib).toBe(expectInspected);
    });
  }
});

const join = (bs: Uint8Array[]): string => bs.map((b) => bytesToText(b)).join("§");

describe("TestStack", () => {
  const tCases: [name: string, data: Uint8Array, expected: string][] = [
    ["empty", raw(` `), ""],
    ["a string", raw(`"abc"`), ""],
    ["an int", raw(`123`), ""],
    ["true", raw(`true`), ""],
    ["false", raw(`false`), ""],
    // Input must be an incomplete JSON because the stack is popped otherwise.
    ["arr", raw(`[`), "["],
    // Put a § between each segment of the stack.
    ["arrr", raw(`[[`), "[§["],
    ["arrrr", raw(`[[[`), "[§[§["],
    ["arrr popped once", raw(`[[[]`), "[§["],
    ["obj", raw(`{`), ""],
    ["obj key", raw(`{"abc":1`), "abc"],
    ["obj key twice", raw(`{"abc":{"def":1`), "abc§def"],
    ["obj key twice but popped", raw(`{"abc":{"def":1}`), "abc"],
    ["obj key twice and arr", raw(`{"abc":{"def":[`), "abc§def§["],
    ["hacky", raw(`{"abc":{"def[":`), "abc§def["],
  ];

  for (const [name, data, expected] of tCases) {
    test(name, () => {
      const p = new parserState(0);
      p.consumeAny(data, [{ SearchPath: [], SearchVals: [] }], 0);
      expect(join(p.currPath)).toBe(expected);
    });
  }
});
