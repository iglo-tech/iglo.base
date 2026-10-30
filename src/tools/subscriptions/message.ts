// Upstream: tools/subscriptions/message.go

const encoder = new TextEncoder();

// the end of every message ("\n\n"), shared by all writes
const messageEnd = encoder.encode("\n\n");

// Message defines a client's channel data.
export class Message {
  constructor(
    readonly name: string,
    readonly data: Uint8Array,
  ) {}

  // WriteSSE writes the current message in a SSE format into the provided
  // writer, as upstream's parts: the `id:`, `event:` and `data:` prefix,
  // the data, then "\n\n". The data and the end are passed as they are
  // (not copied), so a broadcast can share them between clients.
  //
  // For example:
  //
  //	const m = new Message("users/create", data)
  //	m.writeSSE((chunk) => controller.enqueue(chunk), "yourEventId")
  writeSSE(write: (chunk: Uint8Array) => void, eventId: string): void {
    write(encoder.encode("id:" + eventId + "\nevent:" + this.name + "\ndata:"));
    write(this.data);
    write(messageEnd);
  }
}
