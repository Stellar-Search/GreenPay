import { parseProjectUpdates } from '../utils/projectUpdates';

describe('project update forward compatibility', () => {
  it('keeps rendering stable fields when a newer API adds fields and states', () => {
    const parsed = parseProjectUpdates([{
      id: 'update-1',
      projectId: 'project-1',
      title: 'Planting complete',
      body: 'The first planting phase is complete.',
      createdAt: '2026-08-28T10:00:00.000Z',
      moderationStatus: 'future_review_state',
      revision: 7,
      policyAnnotations: { introducedBy: 'newer-api' },
    }]);

    expect(parsed).toEqual([{
      id: 'update-1',
      projectId: 'project-1',
      title: 'Planting complete',
      body: 'The first planting phase is complete.',
      createdAt: '2026-08-28T10:00:00.000Z',
    }]);
  });

  it('skips a malformed newer item without discarding readable updates', () => {
    const parsed = parseProjectUpdates([
      { id: 'future-shape', payload: { title: 'Nested in a future version' } },
      {
        id: 'update-2',
        projectId: 'project-1',
        title: 'Readable update',
        body: 'Known fields remain available.',
        createdAt: '2026-08-28T11:00:00.000Z',
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('Readable update');
  });
});
