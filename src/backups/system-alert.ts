// Upstream: core/system_alert.go

import type { App } from "@/app/app";
import { escapeString } from "@/mail/mails/record";
import type { Record } from "@/records/record-model";
import { findAllRecords } from "@/records/record-query";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";

function systemAlertHTML(appName: string, alertDetails: string): string {
  return String.raw`<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
        body, html {
            padding: 0;
            margin: 0;
            border: 0;
            color: #16161a;
            background: #fff;
            font-size: 14px;
            line-height: 20px;
            font-weight: normal;
            font-family: Source Sans Pro, sans-serif, emoji;
        }
        body {
            padding: 20px 30px;
        }
        p {
            display: block;
            margin: 10px 0;
            font-family: inherit;
        }
        small {
            font-size: 12px;
            line-height: 16px;
        }
        strong {
            font-weight: bold;
        }
        em, i {
            font-style: italic;
        }
        a {
            color: inherit;
        }
        .alert {
        	padding: 15px;
        	background: #e4e8ec;
        	border-radius: 5px;
        	white-space: pre-wrap;
        }
    </style>
</head>
<body>
	<p>${appName} system alert occurred:</p>
	<p class="alert"><strong>${alertDetails}</strong></p>
	<p>For more information you could explore the logs in the dashboard of your application.</p>
</body>
</html>`;
}

const templateEscapes: { [c: string]: string } = {
  "\0": "\uFFFD",
  '"': "&#34;",
  "&": "&amp;",
  "'": "&#39;",
  "+": "&#43;",
  "<": "&lt;",
  ">": "&gt;",
};

// html/template's escaper for a value in HTML text
function templateEscape(s: string): string {
  return s.replace(/[\0"&'+<>]/g, (c) => templateEscapes[c] as string);
}

// sendSystemAlertToAllSuperusers sends a system error alert to all superusers.
export async function sendSystemAlertToAllSuperusers(
  app: App,
  subject: string,
  details: string,
): Promise<void> {
  const superusers = findAllRecords(app, CollectionNameSuperusers);

  const alertErrors: unknown[] = [];
  for (const superuser of superusers) {
    try {
      await sendSystemAlert(app, superuser, subject, details);
    } catch (err) {
      alertErrors.push(err);
    }
  }

  if (alertErrors.length > 0) {
    throw new AggregateError(alertErrors, alertErrors.map(String).join("\n"));
  }
}

// sendSystemAlert sends a system error alert to a single superuser.
async function sendSystemAlert(
  app: App,
  superuser: Record,
  subject: string,
  details: string,
): Promise<void> {
  if (!superuser.isSuperuser()) {
    throw new Error("system alerts can be sent only to superusers");
  }

  if (subject === "" || details === "") {
    throw new Error("system alerts subject and details are required");
  }

  const { AppName, SenderName, SenderAddress } = app.settings.Meta;

  await app.newMailClient().send({
    from: { name: SenderName, address: SenderAddress },
    to: [{ name: "", address: superuser.email() }],
    subject: "[" + AppName + " system alert] " + escapeString(subject),
    html: systemAlertHTML(templateEscape(AppName), templateEscape(details)),
  });
}
