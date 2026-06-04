alter table ww_rooms drop constraint if exists ww_rooms_phase_check;
alter table ww_rooms add constraint ww_rooms_phase_check
check (phase in ('lobby', 'reveal', 'hint', 'discussion', 'vote', 'wolf_guess', 'result'));

create or replace function ww_room_state(room ww_rooms, viewer_id uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  game jsonb := room.current_game;
  player_json jsonb;
  players_json jsonb := '[]'::jsonb;
  hints_json jsonb := '[]'::jsonb;
  viewer_assignment jsonb;
begin
  for player_json in select * from jsonb_array_elements(room.players) loop
    players_json := players_json || jsonb_build_array(
      jsonb_build_object(
        'id', player_json->>'id',
        'name', player_json->>'name',
        'connected', coalesce((player_json->>'connected')::boolean, true),
        'isBot', coalesce((player_json->>'bot')::boolean, false),
        'votedFor', coalesce(game->'votes' ? (player_json->>'id'), false)
      )
    );
  end loop;

  if game is not null then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'playerId', turn.player_id,
          'playerName', ww_player_name(room.players, turn.player_id::uuid),
          'body', game->'hints'->>turn.player_id
        )
        order by turn.ord
      ),
      '[]'::jsonb
    )
    into hints_json
    from (
      select value #>> '{}' as player_id, ord
      from jsonb_array_elements(coalesce(game->'turnOrder', '[]'::jsonb)) with ordinality as t(value, ord)
    ) turn
    where game->'hints' ? turn.player_id;
  end if;

  if game is not null and viewer_id is not null then
    viewer_assignment := game->'assignments'->(viewer_id::text);
  end if;

  return jsonb_build_object(
    'code', room.code,
    'hostId', room.host_id::text,
    'phase', room.phase,
    'round', room.round,
    'settings', room.settings,
    'players', players_json,
    'currentGame',
      case
        when game is null then null
        else jsonb_build_object(
          'category', game->'pair'->>'category',
          'startedAt', (game->>'startedAt')::bigint,
          'phaseEndsAt', (game->>'phaseEndsAt')::bigint,
          'activePlayerId', game->>'activePlayerId',
          'hints', hints_json,
          'votes', coalesce(game->'votes', '{}'::jsonb),
          'result', game->'result',
          'wolfGuess', game->'wolfGuess',
          'viewerWord', viewer_assignment->>'word',
          'viewerRole', viewer_assignment->>'role'
        )
      end
  );
end;
$$;

create or replace function ww_set_phase(
  room ww_rooms,
  next_phase text,
  duration_seconds integer,
  active_player_id text default null,
  extra_game jsonb default '{}'::jsonb
)
returns ww_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  updated_room ww_rooms;
begin
  update ww_rooms
  set
    phase = next_phase,
    current_game =
      jsonb_set(
        jsonb_set(
          coalesce(room.current_game, '{}'::jsonb) || extra_game,
          '{phaseEndsAt}',
          to_jsonb(now_ms + duration_seconds * 1000),
          true
        ),
        '{activePlayerId}',
        case when active_player_id is null then 'null'::jsonb else to_jsonb(active_player_id) end,
        true
      ),
    updated_at = now()
  where code = room.code
  returning * into updated_room;

  return updated_room;
end;
$$;

create or replace function ww_start_round(p_code text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  pair ww_word_pairs;
  wolf_count integer;
  player_count integer;
  shuffled_ids text[];
  wolf_ids text[];
  player_json jsonb;
  assignments jsonb := '{}'::jsonb;
  turn_order jsonb := '[]'::jsonb;
  is_wolf boolean;
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
begin
  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if room.host_id <> p_player_id then
    raise exception '방장만 게임을 시작할 수 있어요.';
  end if;

  player_count := ww_player_count(room.players);
  if player_count < 3 then
    raise exception '워드울프는 최소 3명이 필요해요.';
  end if;

  select * into pair from ww_word_pairs order by random() limit 1;
  if pair.id is null then
    raise exception '단어 DB가 비어 있어요. Sync Word DB 액션을 먼저 실행해주세요.';
  end if;

  wolf_count := least(coalesce((room.settings->>'wolfCount')::integer, 1), greatest(1, player_count - 2));

  select array_agg(player_id order by sort_key), jsonb_agg(to_jsonb(player_id) order by sort_key)
  into shuffled_ids, turn_order
  from (
    select elem->>'id' as player_id, random() as sort_key
    from jsonb_array_elements(room.players) as elem
  ) picked;

  wolf_ids := shuffled_ids[1:wolf_count];

  for player_json in select * from jsonb_array_elements(room.players) loop
    is_wolf := (player_json->>'id') = any(wolf_ids);
    assignments := jsonb_set(
      assignments,
      array[player_json->>'id'],
      jsonb_build_object(
        'role', case when is_wolf then 'wolf' else 'villager' end,
        'word', case when is_wolf then pair.wolf else pair.villager end
      ),
      true
    );
  end loop;

  update ww_rooms
  set
    phase = 'reveal',
    round = room.round + 1,
    current_game = jsonb_build_object(
      'pair', jsonb_build_object('villager', pair.villager, 'wolf', pair.wolf, 'category', pair.category),
      'wolfIds', to_jsonb(wolf_ids),
      'assignments', assignments,
      'turnOrder', turn_order,
      'hintIndex', 0,
      'hints', '{}'::jsonb,
      'votes', '{}'::jsonb,
      'startedAt', now_ms,
      'phaseEndsAt', now_ms + 15 * 1000,
      'activePlayerId', null,
      'result', null,
      'wolfGuess', null
    ),
    updated_at = now()
  where code = room.code
  returning * into room;

  return ww_room_state(room, p_player_id);
end;
$$;

create or replace function ww_submit_wolf_guess(p_code text, p_player_id uuid, p_guess text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  clean_guess text := left(trim(coalesce(p_guess, '')), 40);
  correct boolean;
  wolf_ids text[];
  result jsonb;
begin
  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if room.phase <> 'wolf_guess' then
    raise exception '지금은 울프 단어 추리 시간이 아니에요.';
  end if;
  if room.current_game->>'activePlayerId' <> p_player_id::text then
    raise exception '지목된 울프만 정답을 입력할 수 있어요.';
  end if;

  correct := lower(clean_guess) = lower(room.current_game->'pair'->>'villager');

  select array_agg(value::text)
  into wolf_ids
  from jsonb_array_elements_text(room.current_game->'wolfIds');

  result := jsonb_build_object(
    'eliminatedId', room.current_game->>'eliminatedId',
    'tie', false,
    'winners', case when correct then 'wolves' else 'villagers' end,
    'reason', case when correct then 'wolf_guessed_word' else 'wolf_missed_word' end,
    'words', jsonb_build_object(
      'villager', room.current_game->'pair'->>'villager',
      'wolf', room.current_game->'pair'->>'wolf'
    ),
    'wolves', to_jsonb(wolf_ids),
    'guess', clean_guess,
    'guessCorrect', correct
  );

  update ww_rooms
  set
    phase = 'result',
    current_game = jsonb_set(
      jsonb_set(room.current_game, '{wolfGuess}', to_jsonb(clean_guess), true),
      '{result}',
      result,
      true
    ),
    updated_at = now()
  where code = room.code
  returning * into room;

  return ww_room_state(room, p_player_id);
end;
$$;

create or replace function ww_finish_vote(room ww_rooms)
returns ww_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  top_score integer := 0;
  top_count integer := 0;
  eliminated_id text;
  wolf_ids text[];
  caught_wolf boolean := false;
  result jsonb;
  updated_room ww_rooms;
begin
  select target, score
  into eliminated_id, top_score
  from (
    select value as target, count(*)::integer as score
    from jsonb_each_text(coalesce(room.current_game->'votes', '{}'::jsonb))
    group by value
    order by score desc
    limit 1
  ) ranked;

  if top_score is null then
    eliminated_id := null;
  else
    select count(*)
    into top_count
    from (
      select value as target, count(*)::integer as score
      from jsonb_each_text(coalesce(room.current_game->'votes', '{}'::jsonb))
      group by value
    ) scores
    where score = top_score;

    if top_count <> 1 then
      eliminated_id := null;
    end if;
  end if;

  select array_agg(value::text)
  into wolf_ids
  from jsonb_array_elements_text(room.current_game->'wolfIds');

  caught_wolf := eliminated_id is not null and eliminated_id = any(wolf_ids);

  if caught_wolf then
    return ww_set_phase(
      room,
      'wolf_guess',
      30,
      eliminated_id,
      jsonb_build_object('eliminatedId', eliminated_id)
    );
  end if;

  result := jsonb_build_object(
    'eliminatedId', eliminated_id,
    'tie', eliminated_id is null,
    'winners', 'wolves',
    'reason', case when eliminated_id is null then 'tie' else 'vote_missed_wolf' end,
    'words', jsonb_build_object(
      'villager', room.current_game->'pair'->>'villager',
      'wolf', room.current_game->'pair'->>'wolf'
    ),
    'wolves', to_jsonb(wolf_ids)
  );

  update ww_rooms
  set
    phase = 'result',
    current_game = jsonb_set(room.current_game, '{result}', result, true),
    updated_at = now()
  where code = room.code
  returning * into updated_room;

  return updated_room;
end;
$$;

create or replace function ww_advance_phase(p_code text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  phase_ends_at bigint;
  hint_index integer;
  next_index integer;
  next_player_id text;
  player_count integer;
begin
  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if not ww_has_player(room.players, p_player_id) then
    raise exception '플레이어 정보를 확인할 수 없어요.';
  end if;
  if room.current_game is null or room.phase in ('lobby', 'result') then
    return ww_room_state(room, p_player_id);
  end if;

  phase_ends_at := coalesce((room.current_game->>'phaseEndsAt')::bigint, now_ms);
  if phase_ends_at > now_ms then
    return ww_room_state(room, p_player_id);
  end if;

  if room.phase = 'reveal' then
    next_player_id := room.current_game->'turnOrder'->>0;
    room := ww_set_phase(room, 'hint', 15, next_player_id, jsonb_build_object('hintIndex', 0));
  elsif room.phase = 'hint' then
    hint_index := coalesce((room.current_game->>'hintIndex')::integer, 0);
    if room.current_game->>'activePlayerId' is not null
       and not (coalesce(room.current_game->'hints', '{}'::jsonb) ? (room.current_game->>'activePlayerId')) then
      room.current_game := jsonb_set(
        room.current_game,
        array['hints', room.current_game->>'activePlayerId'],
        to_jsonb('시간 초과'::text),
        true
      );
    end if;

    next_index := hint_index + 1;
    player_count := jsonb_array_length(room.current_game->'turnOrder');

    if next_index >= player_count then
      update ww_rooms
      set current_game = room.current_game
      where code = room.code
      returning * into room;
      room := ww_set_phase(room, 'discussion', 180, null, '{}'::jsonb);
    else
      next_player_id := room.current_game->'turnOrder'->>next_index;
      update ww_rooms
      set current_game = jsonb_set(room.current_game, '{hintIndex}', to_jsonb(next_index), true)
      where code = room.code
      returning * into room;
      room := ww_set_phase(room, 'hint', 15, next_player_id, '{}'::jsonb);
    end if;
  elsif room.phase = 'discussion' then
    room := ww_set_phase(room, 'vote', 30, null, '{}'::jsonb);
  elsif room.phase = 'vote' then
    room := ww_finish_vote(room);
  elsif room.phase = 'wolf_guess' then
    perform ww_submit_wolf_guess(room.code, (room.current_game->>'activePlayerId')::uuid, '');
    select * into room from ww_rooms where code = upper(trim(p_code));
  end if;

  return ww_room_state(room, p_player_id);
end;
$$;

create or replace function ww_submit_hint(p_code text, p_player_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  clean_body text := left(trim(coalesce(p_body, '')), 50);
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
begin
  if clean_body = '' then
    raise exception '힌트를 입력해주세요.';
  end if;

  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if room.phase <> 'hint' then
    raise exception '지금은 힌트 제출 시간이 아니에요.';
  end if;
  if room.current_game->>'activePlayerId' <> p_player_id::text then
    raise exception '지금은 내 차례가 아니에요.';
  end if;
  if room.current_game->'hints' ? p_player_id::text then
    raise exception '이미 힌트를 제출했어요.';
  end if;

  update ww_rooms
  set
    current_game = jsonb_set(
      jsonb_set(room.current_game, array['hints', p_player_id::text], to_jsonb(clean_body), true),
      '{phaseEndsAt}',
      to_jsonb(now_ms - 1),
      true
    ),
    updated_at = now()
  where code = room.code
  returning * into room;

  return ww_advance_phase(room.code, p_player_id);
end;
$$;

create or replace function ww_vote(p_code text, p_player_id uuid, p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  votes jsonb;
  player_count integer;
begin
  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if room.phase <> 'vote' or room.current_game is null then
    raise exception '지금은 투표할 수 없어요.';
  end if;
  if not ww_has_player(room.players, p_player_id) or not ww_has_player(room.players, p_target_id) then
    raise exception '투표 대상을 확인할 수 없어요.';
  end if;
  if p_player_id = p_target_id then
    raise exception '자기 자신에게는 투표할 수 없어요.';
  end if;

  votes := jsonb_set(coalesce(room.current_game->'votes', '{}'::jsonb), array[p_player_id::text], to_jsonb(p_target_id::text), true);
  player_count := ww_player_count(room.players);

  update ww_rooms
  set
    current_game = jsonb_set(room.current_game, '{votes}', votes, true),
    updated_at = now()
  where code = room.code
  returning * into room;

  if (select count(*) from jsonb_each_text(votes)) >= player_count then
    room := ww_finish_vote(room);
  end if;

  return ww_room_state(room, p_player_id);
end;
$$;

create or replace function ww_bot_vote(p_code text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  bot jsonb;
  target_id text;
  votes jsonb;
  player_count integer;
begin
  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if room.host_id <> p_player_id then
    raise exception '방장만 AI 투표를 실행할 수 있어요.';
  end if;
  if room.phase <> 'vote' or room.current_game is null then
    raise exception '지금은 AI 투표를 실행할 수 없어요.';
  end if;

  votes := coalesce(room.current_game->'votes', '{}'::jsonb);

  for bot in
    select *
    from jsonb_array_elements(room.players) as player
    where coalesce((player->>'bot')::boolean, false)
      and not (votes ? (player->>'id'))
  loop
    select player->>'id'
    into target_id
    from jsonb_array_elements(room.players) as player
    where player->>'id' <> bot->>'id'
    order by random()
    limit 1;

    if target_id is not null then
      votes := jsonb_set(votes, array[bot->>'id'], to_jsonb(target_id), true);
    end if;
  end loop;

  player_count := ww_player_count(room.players);

  update ww_rooms
  set
    current_game = jsonb_set(room.current_game, '{votes}', votes, true),
    updated_at = now()
  where code = room.code
  returning * into room;

  if (select count(*) from jsonb_each_text(votes)) >= player_count then
    room := ww_finish_vote(room);
  end if;

  return ww_room_state(room, p_player_id);
end;
$$;

create or replace function ww_finish_room(p_code text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
begin
  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if room.host_id <> p_player_id then
    raise exception '방장만 결과를 열 수 있어요.';
  end if;
  if room.current_game is null then
    raise exception '진행 중인 게임이 없어요.';
  end if;

  if room.phase = 'vote' then
    room := ww_finish_vote(room);
  elsif room.phase = 'wolf_guess' then
    return ww_submit_wolf_guess(room.code, (room.current_game->>'activePlayerId')::uuid, '');
  else
    room := ww_set_phase(room, 'vote', 1, null, '{}'::jsonb);
    room := ww_finish_vote(room);
  end if;

  return ww_room_state(room, p_player_id);
end;
$$;

grant execute on function ww_advance_phase(text, uuid) to anon;
grant execute on function ww_submit_hint(text, uuid, text) to anon;
grant execute on function ww_submit_wolf_guess(text, uuid, text) to anon;
grant execute on function ww_bot_vote(text, uuid) to anon;
