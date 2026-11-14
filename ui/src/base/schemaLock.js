// iglo.base patch (ui/PATCHES.md, D41): the production schema lock.
//
// With `serve --mode prod --schema <file>` the server answers `schemaLocked`
// in the superuser health check. Then the collection and settings screens are
// read-only: the collection edit controls are hidden, the settings forms and
// the import review are inert, and a notice says where the change is made.
// Upstream's dashboard is otherwise unchanged; the server enforces the lock
// with 403 responses, so this only explains it.

const noticeId = "iglo-schema-lock-notice";
const noticeText =
  "Collections and settings are managed by the schema file (production mode). Change iglo.schema.json and restart the server.";

// the buttons of the settings screens that write settings (text, trimmed)
const settingsButtons = ["Review", "Clear"];

let locked = false;
let checkedFor = "";
let scheduled = false;

async function checkLock() {
  const token = app.pb.authStore.token || "";
  if (token === checkedFor) {
    return;
  }
  checkedFor = token;
  locked = false;
  if (token === "") {
    return;
  }
  try {
    const health = await app.pb.health.check({ requestKey: null });
    locked = health?.data?.schemaLocked === true;
  } catch {
    locked = false;
  }
  schedule();
}

function schedule() {
  if (scheduled) {
    return;
  }
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    apply();
  });
}

function setNotice(parent) {
  if (!parent || document.getElementById(noticeId)) {
    return;
  }
  const notice = document.createElement("div");
  notice.id = noticeId;
  notice.className = "alert info m-b-sm";
  notice.setAttribute("role", "status");
  notice.textContent = noticeText;
  const header = parent.querySelector(":scope > .page-header");
  if (header) {
    header.after(notice);
  } else {
    parent.prepend(notice);
  }
}

function apply() {
  if (!locked) {
    return;
  }
  const hash = window.location.hash;
  const onCollections = hash.startsWith("#/collections");
  const onSettings = hash.startsWith("#/settings");

  // the collection edit controls: the sidebar's "New collection" and the cog
  // of the current collection open the collection editor
  if (onCollections) {
    document
      .querySelectorAll(".sidebar-content.new-collection, .btn-collection-settings")
      .forEach((el) => (el.style.display = "none"));
    setNotice(document.querySelector(".page-content"));
  }

  if (onSettings) {
    document.querySelectorAll(".page-content form").forEach((form) => (form.inert = true));
    document.querySelectorAll(".page-content button").forEach((button) => {
      if (settingsButtons.includes(button.textContent.trim())) {
        button.disabled = true;
      }
    });
    setNotice(document.querySelector(".page-content"));
  }

  // the logs settings write the settings too
  document
    .querySelectorAll("button[aria-label*='Logs settings']")
    .forEach((el) => (el.style.display = "none"));
}

window.addEventListener("hashchange", () => {
  schedule();
});

// the page is rendered again after most changes, and the dashboard's own
// bindings reset `inert` on a form: the lock follows both
const observer = new MutationObserver(() => {
  schedule();
});
observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["inert"],
});

app.pb.authStore.onChange(() => {
  checkLock();
});
checkLock();
