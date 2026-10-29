// Upstream: golang.org/x/net v0.61.0 html/foreign.go

import { equalFold } from "@/collections/go-strings";
import { ElementNode, type Node } from "@/tools/html/node";
import type { Attribute } from "@/tools/html/token";

// adjustAttributeNames renames attributes in aa in place, using nameMap.
export function adjustAttributeNames(aa: Attribute[], nameMap: ReadonlyMap<string, string>): void {
  for (const a of aa) {
    const newName = nameMap.get(a.key);
    if (newName !== undefined) {
      a.key = newName;
    }
  }
}

// adjustForeignAttributes adjusts the attributes of foreign elements (SVG,
// MathML) that have a namespace prefix, such as xlink:href, in place.
export function adjustForeignAttributes(aa: Attribute[]): void {
  for (const a of aa) {
    if (a.key === "" || a.key[0] !== "x") {
      continue;
    }
    switch (a.key) {
      case "xlink:actuate":
      case "xlink:arcrole":
      case "xlink:href":
      case "xlink:role":
      case "xlink:show":
      case "xlink:title":
      case "xlink:type":
      case "xml:lang":
      case "xml:space":
      case "xmlns:xlink": {
        const j = a.key.indexOf(":");
        a.namespace = a.key.slice(0, j);
        a.key = a.key.slice(j + 1);
        break;
      }
    }
  }
}

// htmlIntegrationPoint reports whether n is an HTML integration point:
// an element whose content is parsed as HTML even inside foreign content.
export function htmlIntegrationPoint(n: Node): boolean {
  if (n.type !== ElementNode) {
    return false;
  }
  switch (n.namespace) {
    case "math":
      if (n.data === "annotation-xml") {
        for (const a of n.attr) {
          if (a.key === "encoding") {
            if (equalFold(a.val, "text/html") || equalFold(a.val, "application/xhtml+xml")) {
              return true;
            }
          }
        }
      }
      break;
    case "svg":
      switch (n.data) {
        case "desc":
        case "foreignObject":
        case "title":
          return true;
      }
      break;
  }
  return false;
}

// mathMLTextIntegrationPoint reports whether n is a MathML text integration point.
export function mathMLTextIntegrationPoint(n: Node): boolean {
  if (n.namespace !== "math") {
    return false;
  }
  switch (n.data) {
    case "mi":
    case "mo":
    case "mn":
    case "ms":
    case "mtext":
      return true;
  }
  return false;
}

// breakout is the set of HTML elements that break out of foreign content.
export const breakout = new Set<string>([
  "b",
  "big",
  "blockquote",
  "body",
  "br",
  "center",
  "code",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "i",
  "img",
  "li",
  "listing",
  "menu",
  "meta",
  "nobr",
  "ol",
  "p",
  "pre",
  "ruby",
  "s",
  "small",
  "span",
  "strong",
  "strike",
  "sub",
  "sup",
  "table",
  "tt",
  "u",
  "ul",
  "var",
]);

export const svgTagNameAdjustments = new Map<string, string>([
  ["altglyph", "altGlyph"],
  ["altglyphdef", "altGlyphDef"],
  ["altglyphitem", "altGlyphItem"],
  ["animatecolor", "animateColor"],
  ["animatemotion", "animateMotion"],
  ["animatetransform", "animateTransform"],
  ["clippath", "clipPath"],
  ["feblend", "feBlend"],
  ["fecolormatrix", "feColorMatrix"],
  ["fecomponenttransfer", "feComponentTransfer"],
  ["fecomposite", "feComposite"],
  ["feconvolvematrix", "feConvolveMatrix"],
  ["fediffuselighting", "feDiffuseLighting"],
  ["fedisplacementmap", "feDisplacementMap"],
  ["fedistantlight", "feDistantLight"],
  ["feflood", "feFlood"],
  ["fefunca", "feFuncA"],
  ["fefuncb", "feFuncB"],
  ["fefuncg", "feFuncG"],
  ["fefuncr", "feFuncR"],
  ["fegaussianblur", "feGaussianBlur"],
  ["feimage", "feImage"],
  ["femerge", "feMerge"],
  ["femergenode", "feMergeNode"],
  ["femorphology", "feMorphology"],
  ["feoffset", "feOffset"],
  ["fepointlight", "fePointLight"],
  ["fespecularlighting", "feSpecularLighting"],
  ["fespotlight", "feSpotLight"],
  ["fetile", "feTile"],
  ["feturbulence", "feTurbulence"],
  ["foreignobject", "foreignObject"],
  ["glyphref", "glyphRef"],
  ["lineargradient", "linearGradient"],
  ["radialgradient", "radialGradient"],
  ["textpath", "textPath"],
]);

export const mathMLAttributeAdjustments = new Map<string, string>([
  ["definitionurl", "definitionURL"],
]);

export const svgAttributeAdjustments = new Map<string, string>([
  ["attributename", "attributeName"],
  ["attributetype", "attributeType"],
  ["basefrequency", "baseFrequency"],
  ["baseprofile", "baseProfile"],
  ["calcmode", "calcMode"],
  ["clippathunits", "clipPathUnits"],
  ["diffuseconstant", "diffuseConstant"],
  ["edgemode", "edgeMode"],
  ["filterunits", "filterUnits"],
  ["glyphref", "glyphRef"],
  ["gradienttransform", "gradientTransform"],
  ["gradientunits", "gradientUnits"],
  ["kernelmatrix", "kernelMatrix"],
  ["kernelunitlength", "kernelUnitLength"],
  ["keypoints", "keyPoints"],
  ["keysplines", "keySplines"],
  ["keytimes", "keyTimes"],
  ["lengthadjust", "lengthAdjust"],
  ["limitingconeangle", "limitingConeAngle"],
  ["markerheight", "markerHeight"],
  ["markerunits", "markerUnits"],
  ["markerwidth", "markerWidth"],
  ["maskcontentunits", "maskContentUnits"],
  ["maskunits", "maskUnits"],
  ["numoctaves", "numOctaves"],
  ["pathlength", "pathLength"],
  ["patterncontentunits", "patternContentUnits"],
  ["patterntransform", "patternTransform"],
  ["patternunits", "patternUnits"],
  ["pointsatx", "pointsAtX"],
  ["pointsaty", "pointsAtY"],
  ["pointsatz", "pointsAtZ"],
  ["preservealpha", "preserveAlpha"],
  ["preserveaspectratio", "preserveAspectRatio"],
  ["primitiveunits", "primitiveUnits"],
  ["refx", "refX"],
  ["refy", "refY"],
  ["repeatcount", "repeatCount"],
  ["repeatdur", "repeatDur"],
  ["requiredextensions", "requiredExtensions"],
  ["requiredfeatures", "requiredFeatures"],
  ["specularconstant", "specularConstant"],
  ["specularexponent", "specularExponent"],
  ["spreadmethod", "spreadMethod"],
  ["startoffset", "startOffset"],
  ["stddeviation", "stdDeviation"],
  ["stitchtiles", "stitchTiles"],
  ["surfacescale", "surfaceScale"],
  ["systemlanguage", "systemLanguage"],
  ["tablevalues", "tableValues"],
  ["targetx", "targetX"],
  ["targety", "targetY"],
  ["textlength", "textLength"],
  ["viewbox", "viewBox"],
  ["viewtarget", "viewTarget"],
  ["xchannelselector", "xChannelSelector"],
  ["ychannelselector", "yChannelSelector"],
  ["zoomandpan", "zoomAndPan"],
]);
