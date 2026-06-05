create or replace function ww_room_has_live_human(
  p_players jsonb,
  p_updated_at timestamptz,
  p_max_age_ms bigint default 60000,
  p_legacy_max_age interval default interval '5 minutes'
)
returns boolean
language sql
volatile
set search_path = public
as $$
  select exists (
    select 1
    from jsonb_array_elements(coalesce(p_players, '[]'::jsonb)) as player
    where not coalesce((player->>'bot')::boolean, false)
      and (
        (
          player ? 'lastSeenAt'
          and nullif(player->>'lastSeenAt', '')::bigint
            > floor(extract(epoch from clock_timestamp()) * 1000)::bigint - p_max_age_ms
        )
        or (
          not (player ? 'lastSeenAt')
          and p_updated_at > now() - p_legacy_max_age
        )
      )
  );
$$;

create or replace function ww_touch_player(p_room ww_rooms, p_player_id uuid)
returns ww_rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  next_players jsonb;
  touched_room ww_rooms;
begin
  select coalesce(
    jsonb_agg(
      case
        when player->>'id' = p_player_id::text then
          player || jsonb_build_object('connected', true, 'lastSeenAt', now_ms)
        else player
      end
      order by ordinality
    ),
    '[]'::jsonb
  )
  into next_players
  from jsonb_array_elements(p_room.players) with ordinality as elem(player, ordinality);

  update ww_rooms
  set players = next_players, updated_at = now()
  where code = p_room.code
  returning * into touched_room;

  return touched_room;
end;
$$;

create or replace function ww_cleanup_stale_rooms()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from ww_rooms
  where jsonb_array_length(players) = 0
     or not exists (
       select 1
       from jsonb_array_elements(players) as player
       where not coalesce((player->>'bot')::boolean, false)
     )
     or (phase = 'lobby' and not ww_room_has_live_human(players, updated_at, 60000))
     or updated_at < now() - interval '12 hours';
end;
$$;

create or replace function ww_list_rooms()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rooms jsonb;
begin
  perform ww_cleanup_stale_rooms();

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', code,
        'title', coalesce(settings->>'title', code),
        'playerCount', jsonb_array_length(players),
        'maxPlayers', coalesce((settings->>'maxPlayers')::integer, 10),
        'round', round,
        'updatedAt', floor(extract(epoch from updated_at) * 1000)::bigint
      )
      order by updated_at desc
    ),
    '[]'::jsonb
  )
  into rooms
  from ww_rooms
  where phase = 'lobby'
    and coalesce((settings->>'isPrivate')::boolean, false) = false
    and jsonb_array_length(players) < coalesce((settings->>'maxPlayers')::integer, 10)
    and ww_room_has_live_human(players, updated_at, 60000);

  return rooms;
end;
$$;

create or replace function ww_create_room(
  p_name text,
  p_avatar text default 'img1',
  p_title text default null,
  p_max_players integer default 8,
  p_is_private boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room_code text;
  player_id uuid := gen_random_uuid();
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  clean_name text := left(trim(p_name), 16);
  clean_title text := left(trim(coalesce(p_title, '')), 24);
  clean_max_players integer := least(greatest(coalesce(p_max_players, 8), 3), 10);
  clean_avatar text := case
    when p_avatar in ('img1', 'img2', 'img3', 'img4', 'img5', 'img6', 'img7') then p_avatar
    else 'img1'
  end;
  room ww_rooms;
begin
  perform ww_cleanup_stale_rooms();

  if clean_name = '' then
    raise exception '아이디를 입력해주세요.';
  end if;
  if clean_title = '' then
    raise exception '방 제목을 입력해주세요.';
  end if;

  loop
    room_code := ww_random_code(5);
    exit when not exists (select 1 from ww_rooms where code = room_code);
  end loop;

  insert into ww_rooms (code, host_id, settings, players)
  values (
    room_code,
    player_id,
    jsonb_build_object(
      'discussionSeconds', 180,
      'wolfCount', 1,
      'title', clean_title,
      'maxPlayers', clean_max_players,
      'isPrivate', coalesce(p_is_private, false)
    ),
    jsonb_build_array(
      jsonb_build_object(
        'id', player_id::text,
        'name', clean_name,
        'avatar', clean_avatar,
        'connected', true,
        'lastSeenAt', now_ms
      )
    )
  )
  returning * into room;

  return jsonb_build_object('playerId', player_id::text, 'room', ww_room_state(room, player_id));
end;
$$;

create or replace function ww_join_room(p_code text, p_name text, p_avatar text default 'img1')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  player_id uuid := gen_random_uuid();
  now_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  clean_name text := left(trim(p_name), 16);
  max_players integer;
  clean_avatar text := case
    when p_avatar in ('img1', 'img2', 'img3', 'img4', 'img5', 'img6', 'img7') then p_avatar
    else 'img1'
  end;
begin
  perform ww_cleanup_stale_rooms();

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
  if not ww_room_has_live_human(room.players, room.updated_at, 60000) then
    raise exception '이미 종료된 방이에요.';
  end if;

  max_players := coalesce((room.settings->>'maxPlayers')::integer, 10);
  if jsonb_array_length(room.players) >= max_players then
    raise exception '방 인원이 가득 찼어요.';
  end if;

  if exists (select 1 from jsonb_array_elements(room.players) as player where player->>'name' = clean_name) then
    raise exception '이미 사용 중인 아이디예요.';
  end if;

  update ww_rooms
  set
    players = room.players || jsonb_build_array(
      jsonb_build_object(
        'id', player_id::text,
        'name', clean_name,
        'avatar', clean_avatar,
        'connected', true,
        'lastSeenAt', now_ms
      )
    ),
    updated_at = now()
  where code = room.code
  returning * into room;

  return jsonb_build_object('playerId', player_id::text, 'room', ww_room_state(room, player_id));
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

  room := ww_touch_player(room, p_player_id);

  if room.current_game is null or room.phase in ('lobby', 'result') then
    return ww_room_state(room, p_player_id);
  end if;

  phase_ends_at := coalesce((room.current_game->>'phaseEndsAt')::bigint, now_ms);
  if phase_ends_at > now_ms then
    return ww_room_state(room, p_player_id);
  end if;

  if room.phase = 'reveal' then
    next_player_id := room.current_game->'turnOrder'->>0;
    room := ww_set_phase(room, 'hint', 30, next_player_id, jsonb_build_object('hintIndex', 0));
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
      room := ww_set_phase(room, 'hint', 30, next_player_id, '{}'::jsonb);
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

grant execute on function ww_room_has_live_human(jsonb, timestamptz, bigint, interval) to anon;
grant execute on function ww_cleanup_stale_rooms() to anon;
grant execute on function ww_list_rooms() to anon;
grant execute on function ww_create_room(text, text, text, integer, boolean) to anon;
grant execute on function ww_join_room(text, text, text) to anon;
grant execute on function ww_advance_phase(text, uuid) to anon;

notify pgrst, 'reload schema';
