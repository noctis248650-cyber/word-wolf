create or replace function ww_leave_room(p_code text, p_player_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  room ww_rooms;
  remaining_players jsonb := '[]'::jsonb;
  remaining_count integer := 0;
  human_count integer := 0;
  next_host_id uuid;
begin
  select * into room from ww_rooms where code = upper(trim(p_code)) for update;
  if not found then
    return jsonb_build_object('left', true, 'room', null);
  end if;
  if not ww_has_player(room.players, p_player_id) then
    return jsonb_build_object('left', true, 'room', ww_room_state(room, p_player_id));
  end if;

  select coalesce(jsonb_agg(player), '[]'::jsonb)
  into remaining_players
  from jsonb_array_elements(room.players) as player
  where player->>'id' <> p_player_id::text;

  remaining_count := jsonb_array_length(remaining_players);

  select count(*)::integer
  into human_count
  from jsonb_array_elements(remaining_players) as player
  where not coalesce((player->>'bot')::boolean, false);

  if remaining_count = 0 or human_count = 0 then
    delete from ww_rooms where code = room.code;
    return jsonb_build_object('left', true, 'room', null);
  end if;

  if room.host_id = p_player_id then
    select (player->>'id')::uuid
    into next_host_id
    from jsonb_array_elements(remaining_players) as player
    where not coalesce((player->>'bot')::boolean, false)
    limit 1;
  else
    next_host_id := room.host_id;
  end if;

  update ww_rooms
  set
    host_id = next_host_id,
    players = remaining_players,
    updated_at = now()
  where code = room.code
  returning * into room;

  return jsonb_build_object('left', true, 'room', ww_room_state(room, p_player_id));
end;
$$;

grant execute on function ww_leave_room(text, uuid) to anon;
