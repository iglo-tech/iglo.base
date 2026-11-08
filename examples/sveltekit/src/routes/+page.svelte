<script lang="ts">
  let { data } = $props();
</script>

<h1>{data.email ? `signed in as ${data.email}` : "signed out"}</h1>
<nav>
  <a href="/protected">protected</a> · <a href="/live">live</a> · <a href="/login">log in</a>
</nav>
{#if data.email}
  <form method="POST" action="/logout">
    <button type="submit">Log out</button>
  </form>
{/if}
