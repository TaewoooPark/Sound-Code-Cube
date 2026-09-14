import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseGenre, commitGenre, readGenreHistory } from '../src/music/genre-rotation';
import { GENRE_IDS, seededRandom } from '../shared/profiles';

test('genre shuffle visits all eight before repeats and survives page reloads', () => {
  const random = seededRandom(42);
  let history = readGenreHistory(null);
  const heard = [];
  for (let i = 0; i < 80; i++) {
    const genre = chooseGenre(history, random);
    assert.notEqual(genre, history.last);
    history = commitGenre(history, genre);
    heard.push(genre);
    history = readGenreHistory(JSON.parse(JSON.stringify(history)));
  }
  for (let i = 0; i < 80; i += 8) assert.equal(new Set(heard.slice(i, i + 8)).size, 8);
});

test('repeated explicit genre does not defeat refresh diversity; corrupt storage is ignored', () => {
  const history = commitGenre(readGenreHistory(null), 'techno');
  assert.notEqual(chooseGenre(history, () => 0, 'techno'), 'techno');
  assert.deepEqual(readGenreHistory({ last: 'invalid', remaining: ['dub', 'bad', 'dub'] }), { last: null, remaining: ['dub'] });
  for (const random of [() => 0, () => .9999]) assert.ok(GENRE_IDS.includes(chooseGenre(readGenreHistory(null), random)));
});
