<template>
  <!-- Edit-mode bottom bar for personalized deployments (ENABLE_USER_OVERRIDES) -->
  <div class="edit-mode-bottom-banner personal-save-menu">
    <div class="edit-banner-section intro-container">
      <p class="section-sub-title">{{ $t('personal-dashboard.subtitle') }}</p>
      <p class="edit-mode-intro">{{ $t('personal-dashboard.description') }}</p>
    </div>
    <div class="edit-banner-section save-buttons-container">
      <Button class="primary-save" :click="save" :disallow="saving"
        v-tooltip="tooltip($t('personal-dashboard.save-tooltip'))">
        {{ saving ? $t('personal-dashboard.saving') : $t('personal-dashboard.save-btn') }}
        <SaveIcon />
      </Button>
      <Button :click="openHidden" v-tooltip="tooltip($t('personal-dashboard.hidden-tooltip'))">
        {{ $t('personal-dashboard.hidden-btn', { count: hiddenCount }) }}
        <HiddenIcon />
      </Button>
      <Button :click="() => (showResetConfirm = true)" :disallow="saving"
        v-tooltip="tooltip($t('personal-dashboard.reset-tooltip'))">
        {{ $t('personal-dashboard.reset-btn') }}
        <ResetIcon />
      </Button>
      <Button :click="cancel" v-tooltip="tooltip($t('personal-dashboard.cancel-tooltip'))">
        {{ $t('personal-dashboard.cancel-btn') }}
        <CancelIcon />
      </Button>
    </div>

    <!-- Hidden items manager: restores are staged, then applied by Save -->
    <ConfirmDialog
      v-model:open="showHidden"
      :title="$t('personal-dashboard.hidden-title')"
      :confirmText="$t('general.confirm')"
      @confirm="applyUnhide"
    >
      <p v-if="!hiddenEntries.length">{{ $t('personal-dashboard.hidden-none') }}</p>
      <ul v-else class="hidden-list">
        <li v-for="entry in hiddenEntries" :key="entry.id">
          <span class="hidden-name">
            <b v-if="entry.kind === 'section'">{{ entry.name }}</b>
            <template v-else>{{ entry.title }} <small>({{ entry.sectionName }})</small></template>
          </span>
          <button type="button" class="unhide-btn" @click="toggleUnhide(entry.id)">
            {{ stagedUnhide.includes(entry.id)
              ? $t('personal-dashboard.undo-unhide') : $t('personal-dashboard.unhide') }}
          </button>
        </li>
      </ul>
      <p v-if="stagedUnhide.length" class="pending-note">{{ $t('personal-dashboard.hidden-pending') }}</p>
    </ConfirmDialog>

    <ConfirmDialog
      v-model:open="showResetConfirm"
      danger
      :title="$t('personal-dashboard.reset-btn')"
      :message="$t('personal-dashboard.reset-confirm')"
      :confirmText="$t('personal-dashboard.reset-btn')"
      @confirm="reset"
    />

    <!-- 409: never silently overwrite another device's save -->
    <ConfirmDialog
      v-model:open="showConflict"
      danger
      :title="$t('personal-dashboard.conflict-title')"
      :message="$t('personal-dashboard.conflict-message')"
      :confirmText="$t('personal-dashboard.conflict-overwrite')"
      :cancelText="$t('personal-dashboard.conflict-keep')"
      @confirm="overwrite"
    >
      <button type="button" class="reload-btn" @click="discardAndReload">
        {{ $t('personal-dashboard.conflict-reload') }}
      </button>
    </ConfirmDialog>
  </div>
</template>

<script>
import Button from '@/components/FormElements/Button';
import ConfirmDialog from '@/components/FormElements/ConfirmDialog';
import StoreKeys from '@/utils/StoreMutations';
import SaveIcon from '@/assets/interface-icons/interactive-editor-save-disk.svg';
import HiddenIcon from '@/assets/interface-icons/interactive-editor-page-info.svg';
import ResetIcon from '@/assets/interface-icons/interactive-editor-remove.svg';
import CancelIcon from '@/assets/interface-icons/interactive-editor-cancel-changes.svg';

export default {
  name: 'PersonalSaveMenu',
  components: {
    Button, ConfirmDialog, SaveIcon, HiddenIcon, ResetIcon, CancelIcon,
  },
  data() {
    return {
      saving: false,
      showHidden: false,
      showResetConfirm: false,
      showConflict: false,
      conflictRevision: null,
      stagedUnhide: [],
    };
  },
  computed: {
    hidden() {
      return this.$store.state.personal?.hidden || { sections: [], links: [] };
    },
    hiddenEntries() {
      return [
        ...this.hidden.sections.map((s) => ({ ...s, kind: 'section' })),
        ...this.hidden.links.map((l) => ({ ...l, kind: 'link' })),
      ];
    },
    hiddenCount() {
      return this.hiddenEntries.length;
    },
  },
  methods: {
    tooltip(content) {
      return { content };
    },
    async save(opts = {}) {
      if (this.saving) return;
      this.saving = true;
      const result = await this.$store.dispatch(StoreKeys.SAVE_PERSONAL_DASHBOARD, opts);
      this.saving = false;
      if (result.ok) {
        this.$toast.success(this.$t('personal-dashboard.save-success'));
        this.$store.commit(StoreKeys.SET_EDIT_MODE, false);
      } else if (result.conflict) {
        this.conflictRevision = result.currentRevision;
        this.showConflict = true;
      } else {
        // Stay in edit mode so nothing is lost; the Save button retries
        this.$toast.error(this.$t('personal-dashboard.save-error', { message: result.message }));
      }
    },
    overwrite() {
      this.save({ overwriteRevision: this.conflictRevision });
    },
    async discardAndReload() {
      this.showConflict = false;
      await this.$store.dispatch('refreshPersonalDashboard');
      this.$store.commit(StoreKeys.SET_EDIT_MODE, false);
    },
    async reset() {
      this.saving = true;
      const result = await this.$store.dispatch(StoreKeys.RESET_PERSONAL_DASHBOARD);
      this.saving = false;
      if (result.ok) {
        this.$toast.success(this.$t('personal-dashboard.reset-success'));
        this.$store.commit(StoreKeys.SET_EDIT_MODE, false);
      } else if (result.conflict) {
        this.conflictRevision = result.currentRevision;
        this.showConflict = true;
      } else {
        this.$toast.error(this.$t('personal-dashboard.reset-error', { message: result.message }));
      }
    },
    openHidden() {
      this.stagedUnhide = [...this.$store.state.pendingUnhide];
      this.showHidden = true;
    },
    toggleUnhide(id) {
      this.stagedUnhide = this.stagedUnhide.includes(id)
        ? this.stagedUnhide.filter((x) => x !== id) : [...this.stagedUnhide, id];
    },
    applyUnhide() {
      this.$store.commit(StoreKeys.SET_PENDING_UNHIDE, this.stagedUnhide);
    },
    cancel() {
      this.$store.dispatch('refreshPersonalDashboard');
      this.$store.commit(StoreKeys.SET_EDIT_MODE, false);
    },
  },
};
</script>

<style scoped lang="scss">
@import '@/styles/media-queries.scss';

div.personal-save-menu {
  position: fixed;
  display: grid;
  z-index: 5;
  bottom: 0;
  width: 100%;
  padding: 0.25rem 0;
  border-top: 2px solid var(--interactive-editor-color);
  background: var(--interactive-editor-background-darker);
  box-shadow: 0 -5px 7px var(--transparent-50);
  grid-template-columns: 1fr;
  @include laptop-up { grid-template-columns: 1fr 1fr; }

  .edit-banner-section {
    padding: 0.5rem;
    display: grid;
    p { margin: 0; color: var(--interactive-editor-color); cursor: default; }
    p.section-sub-title { font-weight: bold; }
    @include short { &.intro-container { display: none; } }
  }
  .save-buttons-container {
    grid-template-columns: repeat(2, 1fr);
    button {
      margin: 0.25rem;
      max-height: 3rem;
      color: var(--interactive-editor-color);
      border-color: var(--interactive-editor-color);
      background: var(--interactive-editor-background);
      &:hover:not(.disallowed) {
        color: var(--interactive-editor-background);
        background: var(--interactive-editor-color);
      }
      svg { width: 1rem; height: 1rem; margin: 0 0 -0.15rem 0.25rem; }
    }
  }
}
ul.hidden-list {
  list-style: none;
  padding: 0;
  margin: 0;
  max-height: 50vh;
  overflow-y: auto;
  li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: 0.25rem 0;
    border-bottom: 1px dashed var(--transparent-30);
  }
}
.unhide-btn, .reload-btn {
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  border-radius: var(--curve-factor);
  border: 1px solid currentColor;
  background: none;
  color: inherit;
}
.reload-btn { margin-top: 0.5rem; }
.pending-note { font-style: italic; }
</style>
