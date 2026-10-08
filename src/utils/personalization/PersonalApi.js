/* Client for the fork's /api/me endpoints. Auth headers are attached by @/utils/request */
import request from '@/utils/request';

const base = () => `${import.meta.env.VITE_APP_DOMAIN || ''}/api/me`;

/* Normalizes request errors into { status, message, currentRevision? } */
const toError = (e) => ({
  status: e.response?.status || 0,
  message: e.response?.data?.message || e.message || 'Request failed',
  currentRevision: e.response?.data?.currentRevision,
});

export const fetchDashboard = async () => (await request.get(`${base()}/dashboard`)).data;

export const savePreferences = async (preferences, expectedRevision) => {
  try {
    const res = await request.put(`${base()}/preferences`, { preferences, expectedRevision });
    return { ok: true, revision: res.data.revision };
  } catch (e) {
    return { ok: false, ...toError(e) };
  }
};

export const resetPreferences = async (expectedRevision) => {
  try {
    await request({ method: 'DELETE', url: `${base()}/preferences`, data: { expectedRevision } });
    return { ok: true };
  } catch (e) {
    return { ok: false, ...toError(e) };
  }
};
