import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createStore } from 'vuex';
import PersonalSaveMenu from '@/components/InteractiveEditor/PersonalSaveMenu.vue';
import ItemContextMenu from '@/components/LinkItems/ItemContextMenu.vue';

vi.mock('@/utils/logging/ErrorHandler', () => ({ default: vi.fn() }));

const toast = () => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });

function mountMenu(saveResult) {
  const actions = {
    SAVE_PERSONAL_DASHBOARD: vi.fn(async () => saveResult),
    RESET_PERSONAL_DASHBOARD: vi.fn(async () => ({ ok: true })),
    refreshPersonalDashboard: vi.fn(async () => true),
  };
  const mutations = { SET_EDIT_MODE: vi.fn(), SET_PENDING_UNHIDE: vi.fn() };
  const store = createStore({
    state: () => ({
      pendingUnhide: [],
      personal: { hidden: { sections: [{ id: 'sec-mon', name: 'Monitoring' }], links: [] } },
    }),
    actions,
    mutations,
  });
  const $toast = toast();
  const wrapper = mount(PersonalSaveMenu, {
    global: {
      plugins: [store],
      directives: { tooltip: {} },
      mocks: { $t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k), $toast },
      stubs: { ConfirmDialog: { template: '<div class="dlg"><slot /></div>', props: ['open'] } },
    },
  });
  return {
    wrapper, actions, mutations, $toast,
  };
}

const clickButton = async (wrapper, text) => {
  const btn = wrapper.findAll('button').find((b) => b.text().includes(text));
  await btn.trigger('click');
  await new Promise((r) => { setTimeout(r, 0); });
};

describe('PersonalSaveMenu', () => {
  it('shows only personal actions, never Save to Disk / Save Locally', () => {
    const { wrapper } = mountMenu({ ok: true });
    const text = wrapper.text();
    expect(text).toContain('personal-dashboard.save-btn');
    expect(text).toContain('personal-dashboard.reset-btn');
    expect(text).toContain('personal-dashboard.hidden-btn:{"count":1}');
    expect(text).not.toMatch(/save-disk|save-locally/);
  });

  it('confirms success and leaves edit mode', async () => {
    const { wrapper, mutations, $toast } = mountMenu({ ok: true });
    await clickButton(wrapper, 'personal-dashboard.save-btn');
    expect($toast.success).toHaveBeenCalled();
    expect(mutations.SET_EDIT_MODE).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('on error shows a retryable message and stays in edit mode', async () => {
    const { wrapper, mutations, $toast } = mountMenu({ ok: false, message: 'boom' });
    await clickButton(wrapper, 'personal-dashboard.save-btn');
    expect($toast.error).toHaveBeenCalled();
    expect(mutations.SET_EDIT_MODE).not.toHaveBeenCalled();
  });

  it('on 409 opens the conflict dialog instead of overwriting', async () => {
    const { wrapper, actions, mutations } = mountMenu({ ok: false, conflict: true, currentRevision: 9 });
    await clickButton(wrapper, 'personal-dashboard.save-btn');
    expect(wrapper.vm.showConflict).toBe(true);
    expect(actions.SAVE_PERSONAL_DASHBOARD).toHaveBeenCalledTimes(1);
    expect(mutations.SET_EDIT_MODE).not.toHaveBeenCalled();
    wrapper.vm.overwrite();
    expect(actions.SAVE_PERSONAL_DASHBOARD.mock.calls[1][1]).toEqual({ overwriteRevision: 9 });
  });

  it('stages unhide choices for the next save', async () => {
    const { wrapper, mutations } = mountMenu({ ok: true });
    wrapper.vm.openHidden();
    wrapper.vm.toggleUnhide('sec-mon');
    wrapper.vm.applyUnhide();
    expect(mutations.SET_PENDING_UNHIDE).toHaveBeenCalledWith(expect.anything(), ['sec-mon']);
  });
});

describe('ItemContextMenu for company links', () => {
  const mountCtx = (companyItem) => mount(ItemContextMenu, {
    props: { show: true, companyItem },
    global: {
      plugins: [createStore({
        state: () => ({ editMode: true }),
        getters: { permissions: () => ({ allowViewConfig: true }) },
      })],
      mocks: { $t: (k) => k },
    },
  });

  it('offers only "Hide for me" on company links', () => {
    const text = mountCtx(true).text();
    expect(text).toContain('personal-dashboard.hide-for-me');
    expect(text).not.toMatch(/edit-item|move-item|remove-item/);
  });

  it('keeps upstream edit options for personal links', () => {
    const text = mountCtx(false).text();
    expect(text).toMatch(/edit-item/);
    expect(text).not.toContain('hide-for-me');
  });
});
