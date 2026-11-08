<script lang="ts">
  import { page } from "$app/state";

  const failed = $derived(page.url.searchParams.get("error") === "1");
</script>

<h1>Log in</h1>
{#if failed}
  <p role="alert">wrong email or password</p>
{/if}
<form method="POST" action="/session/login">
  <label>Email <input name="email" type="email" required /></label>
  <label>Password <input name="password" type="password" required /></label>
  <button type="submit">Log in</button>
</form>
