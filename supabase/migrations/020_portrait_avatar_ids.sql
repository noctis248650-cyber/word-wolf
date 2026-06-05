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
    when p_avatar in ('img1', 'img2', 'img3', 'img4', 'img5', 'img6', 'img7', 'img8') then p_avatar
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
    when p_avatar in ('img1', 'img2', 'img3', 'img4', 'img5', 'img6', 'img7', 'img8') then p_avatar
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

grant execute on function ww_create_room(text, text, text, integer, boolean) to anon;
grant execute on function ww_join_room(text, text, text) to anon;

notify pgrst, 'reload schema';
