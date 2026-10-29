// A minimal in-process SMTP sink on a free 127.0.0.1 port, for scenarios
// whose servers send mail (upstream's TestMailer in tests/app.go). It
// accepts every message without TLS or AUTH and keeps it in memory. Unlike
// Mailpit (test/support/mailpit.ts) it needs no reference tool, so the
// scenarios that use it also run in plain `bun test`.
//
// One sink is shared by the scenarios of a test process (sharedSmtpSink);
// its listener does not keep the process alive.

export interface SinkMessage {
  // the RCPT TO addresses
  to: string[];
  // the DATA text, with quoted-printable soft line breaks removed
  data: string;
  // when it was received
  received: number;
}

export interface SmtpSink {
  port: number;
  messages: SinkMessage[];
}

let shared: SmtpSink | undefined;

export function sharedSmtpSink(): SmtpSink {
  shared ??= startSmtpSink();
  return shared;
}

interface Session {
  buffer: string;
  to: string[];
  inData: boolean;
  data: string;
}

function startSmtpSink(): SmtpSink {
  const messages: SinkMessage[] = [];
  const decoder = new TextDecoder();

  const listener = Bun.listen<Session>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { buffer: "", to: [], inData: false, data: "" };
        socket.write("220 localhost ESMTP sink\r\n");
      },
      data(socket, chunk) {
        const s = socket.data;
        s.buffer += decoder.decode(chunk);
        for (;;) {
          if (s.inData) {
            const end = s.buffer.indexOf("\r\n.\r\n");
            if (end < 0) {
              return;
            }
            s.data += s.buffer.slice(0, end);
            s.buffer = s.buffer.slice(end + 5);
            s.inData = false;
            messages.push({
              to: s.to,
              data: s.data.replaceAll("=\r\n", ""),
              received: Date.now(),
            });
            s.to = [];
            s.data = "";
            socket.write("250 OK\r\n");
            continue;
          }
          const eol = s.buffer.indexOf("\r\n");
          if (eol < 0) {
            return;
          }
          const line = s.buffer.slice(0, eol);
          s.buffer = s.buffer.slice(eol + 2);
          const verb = line.slice(0, 4).toUpperCase();
          switch (verb) {
            case "EHLO":
              socket.write("250-localhost\r\n250 8BITMIME\r\n");
              break;
            case "HELO":
              socket.write("250 localhost\r\n");
              break;
            case "RCPT": {
              const m = /<([^>]*)>/.exec(line);
              s.to.push(m?.[1] ?? "");
              socket.write("250 OK\r\n");
              break;
            }
            case "DATA":
              s.inData = true;
              socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
              break;
            case "QUIT":
              socket.write("221 Bye\r\n");
              socket.end();
              return;
            default:
              // MAIL, RSET, NOOP
              socket.write("250 OK\r\n");
          }
        }
      },
    },
  });
  listener.unref();

  return { port: listener.port, messages };
}
