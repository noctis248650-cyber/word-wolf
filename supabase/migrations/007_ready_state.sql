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
        'ready', coalesce((player_json->>'ready')::boolean, false),
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

create or replace function ww_toggle_ready(p_code text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  player_json jsonb;
  next_players jsonb := '[]'::jsonb;
  changed boolean := false;
begin
  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if room.phase <> 'lobby' then
    raise exception '대기실에서만 준비 상태를 바꿀 수 있어요.';
  end if;
  if room.host_id = p_player_id then
    raise exception '방장은 준비 상태를 바꾸지 않아도 돼요.';
  end if;

  for player_json in select * from jsonb_array_elements(room.players) loop
    if player_json->>'id' = p_player_id::text then
      changed := true;
      player_json := jsonb_set(
        player_json,
        '{ready}',
        to_jsonb(not coalesce((player_json->>'ready')::boolean, false)),
        true
      );
    end if;
    next_players := next_players || jsonb_build_array(player_json);
  end loop;

  if not changed then
    raise exception '플레이어 정보를 확인할 수 없어요.';
  end if;

  update ww_rooms
  set players = next_players, updated_at = now()
  where code = room.code
  returning * into room;

  return ww_room_state(room, p_player_id);
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
  not_ready_count integer;
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

  select count(*)::integer
  into not_ready_count
  from jsonb_array_elements(room.players) as player
  where player->>'id' <> room.host_id::text
    and not coalesce((player->>'bot')::boolean, false)
    and not coalesce((player->>'ready')::boolean, false);

  if not_ready_count > 0 then
    raise exception '방장 제외 모두 준비 완료해야 시작할 수 있어요.';
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
    players = (
      select coalesce(jsonb_agg(player - 'ready'), '[]'::jsonb)
      from jsonb_array_elements(room.players) as player
    ),
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

grant execute on function ww_toggle_ready(text, uuid) to anon;
