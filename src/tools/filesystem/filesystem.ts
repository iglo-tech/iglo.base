// Upstream: tools/filesystem/filesystem.go (ThumbSizeRegex only)
//
// The filesystem itself (local and S3 storage, thumbnails, serving) comes
// with M3.2, M5.2 and M5.4.

import { mustCompile } from "@/tools/regexp/regexp";

export const ThumbSizeRegex = mustCompile(String.raw`^(\d+)x(\d+)(t|b|f)?$`);
