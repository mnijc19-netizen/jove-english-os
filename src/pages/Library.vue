<script setup lang="ts">
import { computed, ref, onMounted, watch } from "vue";
import { useApp } from "../stores/app";
import { db } from "../db/db";
import type { Material } from "../domain/types";
import { useRequest } from "../composables/useRequest";
import Icon from "../components/Icon.vue";
import SavedRecording from "../components/SavedRecording.vue";
import { materialSchema } from "../db/schema";
const app = useApp(),
  search = ref(""),
  topic = ref("All topics"),
  tab = ref("text"),
  showImport = ref(false),
  title = ref(""),
  input = ref(""),
  url = ref(""),
  generatedTopic = ref("A first conversation with a new flatmate"),
  candidate = ref<Material>(),
  discoveries = ref<{ title: string; url: string; description: string }[]>([]),
  file = ref<File>(),
  fileAudioId = ref("");
const { busy, error, run, cancel } = useRequest();
const loaded = ref(false);
const pending = computed(() => app.materials.filter((m) => !m.approved));
const originals = computed(() =>
  app.audio.filter((a) => a.kind !== "generated"),
);
async function persist() {
  if (!loaded.value) return;
  await db.sessions.put({
    id: "import-draft",
    kind: "import",
    startedAt: Date.now(),
    stage: tab.value,
    draft: {
      title: title.value,
      input: input.value,
      url: url.value,
      generatedTopic: generatedTopic.value,
      fileAudioId: fileAudioId.value,
      candidateId: candidate.value?.id ?? "",
    },
  });
}
watch(
  [title, input, url, generatedTopic, tab, fileAudioId],
  () =>
    void persist().catch(() => {
      error.value = "Draft could not be saved. Keep this page open and retry.";
    }),
  { flush: "sync" },
);
onMounted(async () => {
  const saved = await db.sessions.get("import-draft");
  if (saved) {
    tab.value = saved.stage;
    title.value = String(saved.draft.title ?? "");
    input.value = String(saved.draft.input ?? "");
    url.value = String(saved.draft.url ?? "");
    generatedTopic.value = String(
      saved.draft.generatedTopic ?? generatedTopic.value,
    );
    fileAudioId.value = String(saved.draft.fileAudioId ?? "");
    candidate.value = app.materials.find(
      (m) => m.id === saved.draft.candidateId && !m.approved,
    );
    showImport.value = !!(input.value || fileAudioId.value || candidate.value);
  }
  loaded.value = true;
});
function changeTab(value: string) {
  cancel();
  tab.value = value;
  candidate.value = undefined;
  file.value = undefined;
  fileAudioId.value = "";
  void persist();
}
async function chooseFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0];
  fileAudioId.value = "";
  if (!file.value) return;
  const chosen = file.value;
  await run(async () => {
    if (chosen.size > 25 * 1024 * 1024)
      throw new Error("Choose an audio file smaller than 25 MB.");
    if (
      app.audio.reduce((n, a) => n + a.blob.size, 0) + chosen.size >
      app.settings.audioLimitMB * 1024 * 1024
    )
      throw new Error(
        "Audio storage limit reached. Download recordings or clear generated cache in Settings before importing.",
      );
    const id = crypto.randomUUID();
    await db.audio.put({
      id,
      blob: chosen,
      mimeType: chosen.type,
      createdAt: Date.now(),
      duration: 0,
      kind: "import",
      processed: false,
      label: chosen.name,
    });
    fileAudioId.value = id;
    await persist();
    await app.refresh();
  });
}
const topics = computed(() => [
  "All topics",
  ...new Set(app.materials.map((m) => m.topic)),
]);
const list = computed(() =>
  app.materials.filter(
    (m) =>
      m.approved &&
      (topic.value === "All topics" || m.topic === topic.value) &&
      `${m.title} ${m.topic}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
);
const safeUrl = (u: string) => {
  try {
    const p = new URL(u);
    return ["http:", "https:"].includes(p.protocol) &&
      !p.username &&
      !p.password
      ? p.href
      : undefined;
  } catch {
    return undefined;
  }
};
function fallback(
  text: string,
): Omit<
  Material,
  "id" | "createdAt" | "approved" | "sourceKind" | "sourceLabel" | "synthetic"
> {
  const sentences = text
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
    ?.map((s) => s.trim()) || [text];
  return {
    title: title.value || "A passage to make your own",
    topic: "Everyday life",
    difficulty: 0.4,
    duration: Math.ceil(text.split(/\s+/).length / 2.3),
    transcript: text,
    sentences,
    question: "What is the main idea, and which details support it?",
    answer:
      "Use the original passage to compare your understanding. AI analysis is not available for this imported text yet.",
    keywords: [],
    chunks: app.materials
      .flatMap((m) => m.chunks)
      .filter((c) => text.toLowerCase().includes(c.text.toLowerCase()))
      .slice(0, 4),
  };
}
async function prepare() {
  await run(async (signal) => {
    await persist();
    let text = input.value.trim(),
      kind: Material["sourceKind"] = "text",
      sourceLabel = "Your pasted text",
      sourceUrl: string | undefined,
      synthetic = true;
    if (tab.value === "url") {
      sourceUrl = safeUrl(url.value);
      if (!sourceUrl) throw new Error("Enter a valid public HTTP(S) URL.");
      text = await app.provider.retrieve(sourceUrl, signal);
      kind = "url";
      sourceLabel = "Retrieved excerpt · verify source";
    }
    if (tab.value === "audio") {
      const original = await db.audio.get(fileAudioId.value);
      if (!original)
        throw new Error(
          "Choose an audio file and wait until it is saved locally.",
        );
      text = text || (await app.provider.transcribe(original.blob, signal));
      input.value = text;
      await persist();
      kind = "audio";
      sourceLabel = "Your uploaded audio";
      synthetic = false;
    }
    let content;
    if (tab.value === "generate") {
      content = await app.provider.generateMaterial(
        generatedTopic.value,
        signal,
      );
      kind = "generated";
      sourceLabel = "AI-generated practice";
    } else {
      if (text.length < 30)
        throw new Error(
          "Add at least a short paragraph so there is enough context.",
        );
      if (text.length > 20000)
        throw new Error("Use a focused excerpt under 20,000 characters.");
      content = app.keySet
        ? await app.provider.analyzeMaterial(text, signal)
        : fallback(text);
    }
    candidate.value = {
      ...content,
      id: crypto.randomUUID(),
      title: title.value || content.title,
      sourceKind: kind,
      sourceLabel,
      sourceUrl,
      synthetic,
      approved: false,
      createdAt: Date.now(),
      ...(kind === "audio" && fileAudioId.value
        ? { audioId: fileAudioId.value }
        : {}),
    };
    await db.materials.put(
      materialSchema.parse(JSON.parse(JSON.stringify(candidate.value))),
    );
    await persist();
    await app.refresh();
  });
}
async function approve() {
  if (!candidate.value) return;
  await db.materials.update(candidate.value.id, { approved: true });
  await app.refresh();
  candidate.value = undefined;
  input.value = "";
  title.value = "";
  fileAudioId.value = "";
  file.value = undefined;
  url.value = "";
  await persist();
  showImport.value = false;
  app.notice =
    "Material added to your library. You can now listen, notice and practice with it.";
}
async function discover() {
  const results = await run((signal) =>
    app.provider.discover(generatedTopic.value, signal),
  );
  if (results) discoveries.value = results.filter((r) => safeUrl(r.url));
}
</script>
<template>
  <div class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">INTERESTING ENGLISH, WITH A PURPOSE</p>
        <h1 tabindex="-1">Your little <span class="serif">library.</span></h1>
        <p class="lede">
          Keep the things you’d want to understand even if you weren’t studying.
        </p>
      </div>
      <button class="button primary" @click="showImport = !showImport">
        <Icon name="plus" :size="17" />Add something
      </button>
    </div>
    <section v-if="showImport" class="panel import-panel">
      <div class="row between">
        <h2>Bring your world into practice.</h2>
        <button
          class="icon-button"
          aria-label="Close importer"
          @click="showImport = false"
        >
          <Icon name="close" />
        </button>
      </div>
      <div class="tabs">
        <button
          v-for="t in [
            { id: 'text', name: 'Paste text' },
            { id: 'url', name: 'Website URL' },
            { id: 'audio', name: 'Audio file' },
            { id: 'discover', name: 'Discover' },
            { id: 'generate', name: 'Create practice' },
          ]"
          :key="t.id"
          :class="{ active: tab === t.id }"
          :disabled="busy"
          @click="changeTab(t.id)"
        >
          {{ t.name }}
        </button>
      </div>
      <template v-if="!candidate"
        ><template v-if="['text', 'url', 'audio'].includes(tab)"
          ><label for="material-title"
            >Title <span class="muted">· optional</span></label
          ><input
            id="material-title"
            v-model="title"
            placeholder="A name you’ll remember" /></template
        ><template v-if="tab === 'url'"
          ><label for="source-url">Public source URL</label
          ><input
            id="source-url"
            v-model="url"
            type="url"
            placeholder="https://…"
          />
          <p class="help-text">
            We try supported retrieval. If a website cannot be read, paste its
            text instead. No login or access restrictions are bypassed.
          </p></template
        ><template v-if="tab === 'audio'"
          ><label for="audio-import">Audio file</label
          ><input
            id="audio-import"
            type="file"
            accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg"
            @change="chooseFile" />
          <p class="help-text">
            Up to 25 MB. Your original audio is saved before transcription.
            Without AI, add the transcript below.
          </p>
          <SavedRecording
            v-if="fileAudioId"
            :audio-id="fileAudioId" /></template
        ><template v-if="tab === 'text' || tab === 'audio'"
          ><label for="material-text">{{
            tab === "audio"
              ? "Transcript · optional with AI"
              : "English excerpt"
          }}</label
          ><textarea
            id="material-text"
            v-model="input"
            rows="6"
            placeholder="Paste a short passage, a transcript, or a message you want to understand."
          /></template
        ><template v-if="tab === 'discover' || tab === 'generate'"
          ><label for="discover-topic">What are you curious about?</label
          ><input id="discover-topic" v-model="generatedTopic" />
          <p class="help-text">
            {{
              tab === "discover"
                ? "Find current public sources; review each candidate before using it."
                : "Create a level-appropriate story or situation. It will be labeled as AI-generated."
            }}
          </p></template
        ><button
          v-if="tab === 'discover'"
          class="button primary"
          :disabled="busy || !app.keySet"
          @click="discover"
        >
          {{ busy ? "Finding sources…" : "Find a few good sources" }}</button
        ><button
          v-else
          class="button primary"
          :disabled="busy || (['url', 'generate'].includes(tab) && !app.keySet)"
          @click="prepare"
        >
          {{ busy ? "Preparing your material…" : "Prepare for review"
          }}<Icon name="arrow" :size="16" /></button
        ><button v-if="busy" class="text-button" @click="cancel">Cancel</button>
        <p
          v-if="!app.keySet && ['url', 'discover', 'generate'].includes(tab)"
          class="help-text"
        >
          <RouterLink to="/settings">Connect AI in Settings</RouterLink> to use
          this source. Pasted text and bundled listening work now.
        </p>
        <article v-for="d in discoveries" :key="d.url" class="discovery">
          <h3>
            <a :href="safeUrl(d.url)" target="_blank" rel="noopener noreferrer"
              >{{ d.title }} <Icon name="external" :size="15"
            /></a>
          </h3>
          <p>{{ d.description }}</p>
          <button
            class="text-button"
            @click="
              url = d.url;
              title = d.title;
              tab = 'url';
            "
          >
            Use this source
          </button>
        </article></template
      >
      <div v-else class="candidate-preview">
        <span class="pill">Candidate · review before saving</span>
        <h2>{{ candidate.title }}</h2>
        <p>{{ candidate.sourceLabel }}</p>
        <p class="preview-text">{{ candidate.transcript }}</p>
        <p>
          Check that the excerpt is accurate, appropriate and something you have
          permission to use.
        </p>
        <button class="button primary" @click="approve">
          Approve & add to library <Icon name="check" :size="16" /></button
        ><button class="text-button" @click="candidate = undefined">
          Back to editing
        </button>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button
        v-if="error && tab === 'url'"
        class="text-button"
        @click="tab = 'text'"
      >
        Paste the text instead
      </button>
    </section>
    <div class="library-filters">
      <label class="search-input"
        ><Icon name="library" :size="18" /><input
          v-model="search"
          placeholder="Find something in your library…"
          aria-label="Search materials" /></label
      ><select v-model="topic" aria-label="Filter topic">
        <option v-for="t in topics" :key="t">{{ t }}</option></select
      ><span class="muted">{{ list.length }} materials</span>
    </div>
    <section v-if="pending.length" class="panel section">
      <h2>Unfinished material drafts</h2>
      <div v-for="m in pending" :key="m.id" class="notebook-row">
        <span>{{ m.title }} · {{ m.sourceLabel }}</span
        ><button
          class="text-button"
          @click="
            candidate = m;
            showImport = true;
            persist();
          "
        >
          Review candidate
        </button>
      </div>
    </section>
    <div class="library-grid">
      <article v-for="(m, i) in list" :key="m.id" class="panel library-card">
        <div class="material-art" :class="'art-' + (i % 4)">
          <span class="art-circle"></span
          ><Icon
            :name="
              m.topic.toLowerCase().includes('work')
                ? 'learn'
                : m.topic.toLowerCase().includes('tech')
                  ? 'sparkle'
                  : 'audio'
            "
            :size="48"
          /><span class="pill">{{ m.topic }}</span>
        </div>
        <div class="library-card-body">
          <div class="row between">
            <span class="eyebrow">{{
              m.sourceKind === "curated" ? "CURATED PRACTICE" : m.sourceKind
            }}</span
            ><span class="muted">{{ m.duration }} sec</span>
          </div>
          <h2>{{ m.title }}</h2>
          <p class="material-source">
            {{ m.sourceLabel }}{{ m.synthetic ? " · synthetic speech" : "" }}
          </p>
          <div class="row between">
            <span class="muted">{{ m.chunks.length }} useful expressions</span
            ><RouterLink :to="'/listen?material=' + m.id" class="text-button"
              >Explore <Icon name="arrow" :size="16"
            /></RouterLink>
          </div>
          <a
            v-if="m.sourceUrl && safeUrl(m.sourceUrl)"
            :href="safeUrl(m.sourceUrl)"
            target="_blank"
            rel="noopener noreferrer"
            class="source-link"
            >Original source <Icon name="external" :size="12"
          /></a>
        </div>
      </article>
    </div>
    <div v-if="!list.length" class="empty-state">
      <Icon name="library" :size="35" />
      <h2>Nothing here just yet.</h2>
      <p>Try another filter, or bring in a passage of your own.</p>
    </div>
    <section v-if="originals.length" class="section">
      <h2>Your recordings and original audio</h2>
      <p class="help-text">
        These originals are never silently evicted. Download important files
        separately; JSON backups contain metadata only.
      </p>
      <details v-for="a in originals" :key="a.id" class="panel">
        <summary>
          {{ a.label }} · {{ new Date(a.createdAt).toLocaleDateString() }}
        </summary>
        <SavedRecording :audio-id="a.id" :label="a.label" />
      </details>
    </section>
    <section v-if="app.conversations.length" class="panel section">
      <h2>Conversation history</h2>
      <div
        v-for="c in [...app.conversations].sort(
          (a, b) => b.startedAt - a.startedAt,
        )"
        :key="c.id"
        class="notebook-row"
      >
        <span
          >{{ new Date(c.startedAt).toLocaleDateString() }} · {{ c.mode }} ·
          {{
            c.messages.filter((m) => m.role === "user").length
          }}
          responses</span
        ><RouterLink
          :to="{ path: '/speak', query: { conversation: c.id } }"
          class="text-button"
          >{{ c.completedAt ? "Revisit" : "Continue" }}</RouterLink
        >
      </div>
    </section>
  </div>
</template>
