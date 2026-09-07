<script setup lang="ts">
import {
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  BarChart3,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Download,
  Headphones,
  Layers3,
  Library,
  Menu,
  Mic,
  Moon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Target,
  Upload,
  Volume2,
  X,
} from "lucide-vue-next";
defineProps<{ name: string; size?: number }>();
const icons: Record<string, unknown> = {
  arrow: ArrowRight,
  external: ArrowUpRight,
  audio: AudioLines,
  progress: BarChart3,
  learn: BookOpen,
  check: Check,
  left: ChevronLeft,
  right: ChevronRight,
  help: CircleHelp,
  clock: Clock3,
  download: Download,
  listen: Headphones,
  review: Layers3,
  library: Library,
  menu: Menu,
  speak: Mic,
  moon: Moon,
  pause: Pause,
  play: Play,
  plus: Plus,
  refresh: RefreshCw,
  settings: Settings2,
  shield: ShieldCheck,
  sparkle: Sparkles,
  sun: Sun,
  today: Target,
  upload: Upload,
  volume: Volume2,
  close: X,
};
</script>
<template>
  <component
    :is="icons[name] || icons.today"
    :size="size || 20"
    :stroke-width="1.7"
    aria-hidden="true"
  />
</template>
