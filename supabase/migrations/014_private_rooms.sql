create or replace function ww_list_rooms()
returns jsonb
language sql
security definer
set search_path = public
as $$
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
  from ww_rooms
  where phase = 'lobby'
    and coalesce((settings->>'isPrivate')::boolean, false) = false
    and jsonb_array_length(players) < coalesce((settings->>'maxPlayers')::integer, 10);
$$;

drop function if exists ww_create_room(text, text, text, integer);
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
  clean_name text := left(trim(p_name), 16);
  clean_title text := left(trim(coalesce(p_title, '')), 24);
  clean_max_players integer := least(greatest(coalesce(p_max_players, 8), 3), 10);
  clean_avatar text := case
    when p_avatar in ('img1', 'img2', 'img3', 'img4', 'img5', 'img6') then p_avatar
    else 'img1'
  end;
  room ww_rooms;
begin
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
    jsonb_build_array(jsonb_build_object('id', player_id::text, 'name', clean_name, 'avatar', clean_avatar, 'connected', true))
  )
  returning * into room;

  return jsonb_build_object('playerId', player_id::text, 'room', ww_room_state(room, player_id));
end;
$$;

grant execute on function ww_list_rooms() to anon;
grant execute on function ww_create_room(text, text, text, integer, boolean) to anon;

notify pgrst, 'reload schema';
