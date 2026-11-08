<script lang="ts">
  import { page } from "$app/state";

  let { data } = $props();

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
<h2>Or</h2>
<!-- the OAuth2 redirect flow: the adapter's start route sends the browser to the provider -->
{#each data.providers as provider (provider.name)}
  <p>
    <a href="/api/pb/oauth2/start/{encodeURIComponent(provider.name)}">Sign in with {provider.displayName}</a>
  </p>
{/each}
