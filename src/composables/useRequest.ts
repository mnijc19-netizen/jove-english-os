import { onBeforeUnmount, ref } from "vue";
export function useRequest() {
  const busy = ref(false),
    error = ref("");
  let controller: AbortController | undefined;
  let disposed = false;
  function cancel() {
    const previous = controller;
    controller = undefined;
    busy.value = false;
    previous?.abort();
  }
  async function run<T>(
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    if (busy.value || disposed) return undefined;
    const current = new AbortController();
    controller = current;
    busy.value = true;
    error.value = "";
    try {
      const result = await fn(current.signal);
      return controller === current && !current.signal.aborted && !disposed
        ? result
        : undefined;
    } catch (e) {
      if (controller === current && !current.signal.aborted && !disposed) {
        error.value =
          e instanceof Error
            ? e.message
            : "Something went wrong. Your input is unchanged.";
      }
      return undefined;
    } finally {
      if (controller === current) {
        controller = undefined;
        busy.value = false;
      }
    }
  }
  onBeforeUnmount(() => {
    disposed = true;
    cancel();
  });
  return { busy, error, run, cancel };
}
