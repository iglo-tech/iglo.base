// Upstream: tools/types/geo_point.go
//
// GeoPoint stores geo coordinates as a serialized json object
// ({"lon":0,"lat":0}). Object notation, not an array, because there is no
// fixed standard for the coordinates order.

import { JSONRaw } from "@/tools/types/json-raw";
import {
  type JSONMarshaler,
  float64Type,
  formatFloat,
  marshal,
  unmarshalStruct,
} from "@/tools/types/go-json";

export class GeoPoint implements JSONMarshaler {
  constructor(
    public lon = 0,
    public lat = 0,
  ) {}

  // String returns the json form, in the Go struct field order; "" when it
  // cannot be marshaled (a NaN or infinite coordinate), as upstream ignores
  // json.Marshal's error.
  string(): string {
    try {
      return this.marshalJSON();
    } catch {
      return "";
    }
  }

  toString(): string {
    return this.string();
  }

  // json.Marshal of the struct: throws on a NaN or infinite coordinate.
  marshalJSON(): string {
    return `{"lon":${formatFloat(this.lon)},"lat":${formatFloat(this.lat)}}`;
  }

  // AsMap returns a value suitable to be used in an API rule expression.
  asMap(): { lon: number; lat: number } {
    return { lon: this.lon, lat: this.lat };
  }

  // Value implements the db driver Valuer: the json form, or json.Marshal's
  // error.
  value(): string {
    return this.marshalJSON();
  }

  // Scan sets the point from nil (no-op), another GeoPoint, or a json object
  // with lon/lat members (string, bytes, JSONRaw, or any other value that
  // is marshaled first). Members are applied as they are read, so a failed
  // scan may have changed the point, as in Go.
  scan(value: unknown): void {
    try {
      if (value === null || value === undefined) {
        // no cast needed
      } else if (value instanceof GeoPoint) {
        this.lon = value.lon;
        this.lat = value.lat;
      } else if (value instanceof JSONRaw) {
        if (value.bytes().length !== 0) {
          this.unmarshal(value.bytes());
        }
      } else if (value instanceof Uint8Array || typeof value === "string") {
        if (value.length !== 0) {
          this.unmarshal(value);
        }
      } else {
        let raw: string;
        try {
          raw = marshal(value);
        } catch (err) {
          throw new Error(`unable to marshalize value for scanning: ${(err as Error).message}`, {
            cause: err,
          });
        }
        this.unmarshal(raw);
      }
    } catch (err) {
      throw new Error(
        `[GeoPoint] unable to scan value ${String(value)}: ${(err as Error).message}`,
        {
          cause: err,
        },
      );
    }
  }

  private unmarshal(data: string | Uint8Array): void {
    unmarshalStruct(
      data,
      {
        lon: (v) => {
          this.lon = v as number;
        },
        lat: (v) => {
          this.lat = v as number;
        },
      },
      { lon: float64Type, lat: float64Type },
      () => {
        this.lon = 0;
        this.lat = 0;
      },
    );
  }
}
