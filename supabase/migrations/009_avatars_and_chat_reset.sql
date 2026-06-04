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
        'avatar', coalesce(player_json->>'avatar', case when coalesce((player_json->>'bot')::boolean, false) then 'bot' else 'spark' end),
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

drop function if exists ww_create_room(text);
create or replace function ww_create_room(p_name text, p_avatar text default 'spark')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room_code text;
  player_id uuid := gen_random_uuid();
  clean_name text := left(trim(p_name), 16);
  clean_avatar text := case
    when p_avatar in ('spark', 'moon', 'mask', 'flame', 'crystal') then p_avatar
    else 'spark'
  end;
  room ww_rooms;
begin
  if clean_name = '' then
    raise exception '아이디를 입력해주세요.';
  end if;

  loop
    room_code := ww_random_code(5);
    exit when not exists (select 1 from ww_rooms where code = room_code);
  end loop;

  insert into ww_rooms (code, host_id, players)
  values (
    room_code,
    player_id,
    jsonb_build_array(jsonb_build_object('id', player_id::text, 'name', clean_name, 'avatar', clean_avatar, 'connected', true))
  )
  returning * into room;

  return jsonb_build_object('playerId', player_id::text, 'room', ww_room_state(room, player_id));
end;
$$;

drop function if exists ww_join_room(text, text);
create or replace function ww_join_room(p_code text, p_name text, p_avatar text default 'spark')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  player_id uuid := gen_random_uuid();
  clean_name text := left(trim(p_name), 16);
  clean_avatar text := case
    when p_avatar in ('spark', 'moon', 'mask', 'flame', 'crystal') then p_avatar
    else 'spark'
  end;
begin
  if clean_name = '' then
    raise exception '아이디를 입력해주세요.';
  end if;

  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    raise exception '방을 찾을 수 없어요.';
  end if;
  if room.phase <> 'lobby' then
    raise exception '진행 중인 방에는 입장할 수 없어요.';
  end if;
  if exists (select 1 from jsonb_array_elements(room.players) as player where player->>'name' = clean_name) then
    raise exception '이미 사용 중인 아이디예요.';
  end if;

  update ww_rooms
  set
    players = room.players || jsonb_build_array(jsonb_build_object('id', player_id::text, 'name', clean_name, 'avatar', clean_avatar, 'connected', true)),
    updated_at = now()
  where code = room.code
  returning * into room;

  return jsonb_build_object('playerId', player_id::text, 'room', ww_room_state(room, player_id));
end;
$$;

create or replace function ww_reset_room(p_code text, p_player_id uuid)
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
    raise exception '방장만 다음 판을 준비할 수 있어요.';
  end if;

  delete from ww_messages where room_code = room.code;

  update ww_rooms
  set
    phase = 'lobby',
    current_game = null,
    updated_at = now()
  where code = room.code
  returning * into room;

  return ww_room_state(room, p_player_id);
end;
$$;

grant execute on function ww_create_room(text, text) to anon;
grant execute on function ww_join_room(text, text, text) to anon;
grant execute on function ww_reset_room(text, uuid) to anon;
