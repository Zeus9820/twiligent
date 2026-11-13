import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAccountViews } from '../../../services/instagram/accountViews.ts';
import { installFetch, reply } from '../../fixtures/fakeFetch.ts';
import type { FetchMock } from '../../fixtures/fakeFetch.ts';
let mock: FetchMock | null = null;
afterEach(() => mock?.restore());
test('requests account views for exact UTC dates, not summed media views', async () => {
    mock = installFetch(request => {
        const url = new URL(request.url);
        assert.equal(url.pathname.endsWith('/17841/insights'), true);
        assert.equal(url.searchParams.get('metric'), 'views');
        assert.equal(url.searchParams.get('metric_type'), 'total_value');
        assert.equal(Number(url.searchParams.get('until')) - Number(url.searchParams.get('since')), 30 * 86400);
        return reply({ data: [{ name: 'views', total_value: { value: 106000 } }] });
    });
    assert.equal((await fetchAccountViews('17841', 'TOKEN', '2026-10-14', '2026-11-12')).views, 106000);
});
test('missing views remain unavailable and invalid ranges are rejected', async () => {
    mock = installFetch(() => reply({ data: [] }));
    assert.equal((await fetchAccountViews('17841', 'TOKEN', '2026-11-01', '2026-11-12')).views, null);
    await assert.rejects(fetchAccountViews('17841', 'TOKEN', '2026-02-30', '2026-03-01'));
    await assert.rejects(fetchAccountViews('17841', 'TOKEN', '2026-10-01', '2026-11-12'));
});
