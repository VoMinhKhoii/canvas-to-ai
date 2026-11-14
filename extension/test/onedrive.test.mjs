import { test } from 'node:test';
import assert from 'node:assert/strict';

const { scanOneDrive, folderUrlOf, shareId, recordingName } = await import('../src/onedrive/scan.js');
const { oneDriveFiles } = await import('../src/onedrive/adapter.js');

// A recorded-style SharePoint: url → JSON, or a status to fail with.
function fakeDrive(routes) {
  const asked = [];
  return {
    asked,
    async get(url) {
      asked.push(url);
      const r = routes[url];
      if (r === undefined) throw Object.assign(new Error(`404 for ${url}`), { status: 404 });
      if (typeof r === 'number') throw Object.assign(new Error(`OneDrive answered ${r}`), { status: r });
      return r;
    },
  };
}

const MY = 'https://uni-my.sharepoint.com';
const SITE = 'https://uni.sharepoint.com';
const SEL = '$select=id,name,size,file,folder,parentReference,webUrl,lastModifiedDateTime';
const item = (origin, drive, id) => `${origin}/_api/v2.0/drives/${drive}/items/${id}`;

const recording = {
  remoteItem: {
    id: 'R1', name: 'Systems Architecture Online Lecture-20261110_143613-Meeting Recording.mp4', file: {}, size: 9e8,
    webUrl: `${MY}/personal/lecturer/Documents/Recordings/x.mp4`, parentReference: { driveId: 'D1' },
    shared: { sharedDateTime: '2026-11-10T09:39:13Z', sharedBy: { user: { displayName: 'Tri Huynh' } } },
  },
};
const older = {
  remoteItem: {
    id: 'R0', name: 'Systems Architecture Online Lecture-20261103_143519-Meeting Recording.mp4', file: {},
    webUrl: `${MY}/personal/lecturer/Documents/Recordings/y.mp4`, parentReference: { driveId: 'D1' },
    shared: { sharedDateTime: '2026-11-03T09:00:00Z', sharedBy: { user: { displayName: 'Tri Huynh' } } },
  },
};
const chatFile = {
  remoteItem: {
    id: 'F1', name: 'c4-lab.html', file: {}, webUrl: `${MY}/personal/lecturer/Documents/Microsoft Teams Chat Files/c4-lab.html`,
    parentReference: { driveId: 'D1' }, shared: { sharedDateTime: '2026-11-11T00:00:00Z', sharedBy: { user: { displayName: 'Tri Huynh' } } },
  },
};
const sharedFolder = {
  remoteItem: { id: 'S1', name: 'RoomScanner', folder: {}, webUrl: `${MY}/personal/friend/Documents/RoomScanner`, parentReference: { driveId: 'D2' }, shared: { sharedDateTime: '2026-11-01T00:00:00Z', sharedBy: { user: { displayName: 'An Nguyen' } } } },
};

const baseRoutes = {
  [`${MY}/_api/v2.0/me/drive/sharedWithMe?$top=200`]: { value: [older, chatFile, recording, sharedFolder] },
  [`${item(MY, 'D1', 'R1')}/media/transcripts`]: { value: [{ id: 'T1', isDefault: true, displayName: 'Lecture.json', size: 1000, temporaryDownloadUrl: `${MY}/t1?tempauth=x` }] },
  [`${item(MY, 'D1', 'R0')}/media/transcripts`]: { value: [] },
};

test('the folder a SharePoint tab shows', () => {
  assert.equal(folderUrlOf(`${SITE}/sites/Class/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FClass%2FShared%20Documents%2FGeneral&viewid=1`), `${SITE}/sites/Class/Shared%20Documents/General`);
  assert.equal(folderUrlOf(`${MY}/my?id=%2Fpersonal%2Fme%2FDocuments%2FNotes`), `${MY}/personal/me/Documents/Notes`);
  // A folder name with characters a URL reserves stays one folder name.
  assert.equal(folderUrlOf(`${SITE}/sites/Class/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FClass%2FShared%20Documents%2FWeek%20%231%20%3F%20100%25`), `${SITE}/sites/Class/Shared%20Documents/Week%20%231%20%3F%20100%25`);
  assert.equal(folderUrlOf(`${SITE}/sites/Class/Shared%20Documents/Forms/AllItems.aspx`), `${SITE}/sites/Class/Shared%20Documents`);
  assert.equal(folderUrlOf(`${SITE}/:f:/r/sites/Class/Shared%20Documents/General?csf=1`), `${SITE}/:f:/r/sites/Class/Shared%20Documents/General?csf=1`);
  assert.equal(folderUrlOf(`${MY}/`), null);
  assert.equal(shareId('https://a.sharepoint.com/x?y'), `u!${Buffer.from('https://a.sharepoint.com/x?y').toString('base64url')}`);
});

test('a Teams meeting recording is named by its meeting and time', () => {
  assert.deepEqual(recordingName('Systems Architecture and Design Online Lecture-20261110_143613-Meeting Recording.mp4'), { meeting: 'Systems Architecture and Design Online Lecture', when: '10 Nov 2026, 14:36' });
  assert.equal(recordingName('holiday.mp4'), null);
  // A UTC time is shown in the student's own zone.
  const local = new Date(Date.UTC(2026, 8, 16, 6, 45));
  assert.deepEqual(recordingName('[Online] Job-Hunt Ready Workshop _2-20260916_064538UTC-Meeting Recording.mp4'), {
    meeting: '[Online] Job-Hunt Ready Workshop _2',
    when: `${local.getDate()} Sep 2026, ${String(local.getHours()).padStart(2, '0')}:45`,
  });
});

test('OneDrive home: recordings with their transcripts, then shared files by who shared them', async () => {
  const course = await scanOneDrive(fakeDrive(baseRoutes), `${MY}/`);
  assert.equal(course.root, 'OneDrive');
  assert.deepEqual(course.folders.map((f) => f.title), ['Recordings shared with you', 'Files shared with you']);
  const [recs, shared] = course.folders;
  assert.equal(recs.sections.length, 1);
  assert.equal(recs.sections[0].title, 'Systems Architecture Online Lecture');
  // Newest first; the transcript (readable) before its video (download only).
  assert.deepEqual(recs.sections[0].items.map((i) => [i.title, i.fileName]), [
    ['10 Nov 2026, 14:36 (transcript)', 'Systems Architecture Online Lecture-20261110_143613-Meeting Recording.vtt'],
    ['10 Nov 2026, 14:36 (video)', 'Systems Architecture Online Lecture-20261110_143613-Meeting Recording.mp4'],
    ['3 Nov 2026, 14:35', 'Systems Architecture Online Lecture-20261103_143519-Meeting Recording.mp4'],
  ]);
  assert.equal(recs.sections[0].items[0].id, `${item(MY, 'D1', 'R1')}/media/transcripts/T1`);
  assert.deepEqual(shared.sections.map((s) => [s.title, s.items.map((i) => [i.title, Boolean(i.locked)])]), [
    ['From Tri Huynh', [['c4-lab.html', false]]],
    ['From An Nguyen', [['RoomScanner', true]]],
  ]);
  const keys = course.folders.flatMap((f) => f.sections.flatMap((s) => s.items.map((i) => i.key)));
  assert.equal(new Set(keys).size, keys.length);
});

test('a Teams channel folder: its files, then a card per subfolder with its own subfolders as sections', async () => {
  const tab = `${SITE}/sites/Class/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FClass%2FShared%20Documents%2FGeneral`;
  const folder = (id, name) => ({ id, name, folder: {}, webUrl: `${SITE}/sites/Class/Shared Documents/General/${name}`, parentReference: { driveId: 'DC' } });
  const file = (id, name) => ({ id, name, file: {}, size: 10, webUrl: `${SITE}/sites/Class/Shared Documents/General/${name}`, parentReference: { driveId: 'DC' } });
  const children = (id) => `${item(SITE, 'DC', id)}/children?$top=200&${SEL}`;
  const routes = {
    ...baseRoutes,
    [`${MY}/_api/v2.0/me/drive/sharedWithMe?$top=200`]: { value: [] }, // read from the OneDrive host, not the team site's
    [`${SITE}/_api/v2.0/shares/${shareId(`${SITE}/sites/Class/Shared%20Documents/General`)}/driveItem?${SEL}`]: { ...folder('G', 'General'), webUrl: `${SITE}/sites/Class/Shared Documents/General` },
    [children('G')]: { value: [folder('W10', 'Week 10'), file('O', 'Outline.pdf'), folder('W2', 'Week 2')], '@odata.nextLink': `${children('G')}&page=2` },
    [`${children('G')}&page=2`]: { value: [file('A', 'Assessment.docx')] },
    [children('W2')]: { value: [file('S2', 'Slides.pptx'), folder('L2', 'Lab')] },
    [children('L2')]: { value: [file('L', 'lab.py'), folder('Deep', 'Solutions')] },
    [children('W10')]: 403,
  };
  const course = await scanOneDrive(fakeDrive(routes), tab);
  assert.equal(course.name, 'General');
  assert.deepEqual(course.folders.map((f) => f.title), ['General', 'Week 2', 'Week 10']); // numeric order; nothing shared
  assert.deepEqual(course.folders[0].sections[0].items.map((i) => i.title), ['Assessment.docx', 'Outline.pdf']);
  assert.deepEqual(course.folders[1].sections.map((s) => [s.title, s.items.map((i) => [i.title, Boolean(i.locked)])]), [
    [null, [['Slides.pptx', false]]],
    ['Lab', [['lab.py', false], ['Solutions', true]]], // deeper folders: open them in the tab
  ]);
  assert.deepEqual(course.folders[2].sections[0].items.map((i) => i.locked), ['A folder: open it in this tab to list its files']); // closed to the student
  assert.equal(course.folders[1].sections[0].items[0].id, item(SITE, 'DC', 'S2'));
});

test('an ended login is said in words, not as a closed course', async () => {
  await assert.rejects(scanOneDrive(fakeDrive({ [`${MY}/_api/v2.0/me/drive/sharedWithMe?$top=200`]: 403 }), `${MY}/`), (e) => e.loggedOut && !e.status && /Log in to OneDrive/.test(e.message));
});

test('a class folder still reads when OneDrive (shared with you) does not', async () => {
  const tab = `${SITE}/sites/Class/Shared%20Documents/Forms/AllItems.aspx`;
  const course = await scanOneDrive(fakeDrive({
    [`${MY}/_api/v2.0/me/drive/sharedWithMe?$top=200`]: 403,
    [`${SITE}/_api/v2.0/shares/${shareId(`${SITE}/sites/Class/Shared%20Documents`)}/driveItem?${SEL}`]: { id: 'ROOT', name: 'root', folder: {}, webUrl: `${SITE}/sites/Class/Shared%20Documents`, parentReference: { driveId: 'DC' } },
    [`${SITE}/_api/v2.0/drives/DC?$select=name,owner`]: { name: 'Documents', owner: { group: { displayName: 'Real Time Systems, Semester 2 Owners' } } },
    [`${item(SITE, 'DC', 'ROOT')}/children?$top=200&${SEL}`]: { value: [{ id: 'X', name: 'Unit guide.pdf', file: {}, webUrl: `${SITE}/sites/Class/Shared%20Documents/Unit guide.pdf`, parentReference: { driveId: 'DC' } }] },
  }), tab);
  assert.equal(course.name, 'Real Time Systems, Semester 2'); // the team's name, from its library's owner
  assert.deepEqual(course.folders.map((f) => [f.title, f.sections[0].items.map((i) => i.title)]), [['Files', ['Unit guide.pdf']]]);
});

test('file details: download addresses that do not expire, sent with the login', async () => {
  const od = fakeDrive({
    ...baseRoutes,
    [`${item(MY, 'D1', 'F1')}?$select=name,size`]: { name: 'c4-lab.html', size: 42 },
  });
  const asked = [];
  const files = oneDriveFiles(od, { fetch: async (url, init) => (asked.push([url, init.credentials]), new Response('x')) });
  assert.deepEqual(await files.meta(item(MY, 'D1', 'F1')), { name: 'c4-lab.html', size: 42, url: `${item(MY, 'D1', 'F1')}/content`, locked: null });
  const transcript = `${item(MY, 'D1', 'R1')}/media/transcripts/T1`;
  assert.deepEqual(await files.meta(transcript), { name: 'Lecture.vtt', size: 1000, url: `${transcript}/streamContent`, locked: null });
  assert.equal((await files.meta(`${item(MY, 'D1', 'R1')}/media/transcripts/GONE`)).locked, 'The transcript is gone');
  await files.bytes(`${transcript}/streamContent`);
  assert.deepEqual(asked, [[`${transcript}/streamContent`, 'include']]);
});
