<script lang="ts">
  import { onMount } from "svelte";
  import { createBrowserClient } from "@iglo.tech/iglo.base/ssr/browser";

  let { data } = $props();

  let subscribed = $state(false);
  let ids: string[] = $state([]);

  onMount(() => {
    if (!data.browser) {
      return;
    }
    const pb = createBrowserClient({
      url: data.url,
      token: data.browser.token,
      record: data.browser.record,
      serverTime: data.browser.serverTime,
      renewUrl: "/api/pb/renew",
    });
    pb.collection("ssr_live")
      .subscribe("*", (e) => {
        ids = [...ids, e.record.id];
      })
      .then(() => {
        subscribed = true;
      });
    return () => pb.dispose();
  });
</script>

<h1>live</h1>
{#if !data.browser}
  <p>not signed in</p>
{:else}
  <p>{subscribed ? "subscribed" : "connecting"}</p>
  <ul>
    {#each ids as id (id)}
      <li>{id}</li>
    {/each}
  </ul>
{/if}
