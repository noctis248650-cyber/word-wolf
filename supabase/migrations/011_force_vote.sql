create or replace function ww_force_vote(p_code text, p_player_id uuid)
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
    raise exception '방장만 즉시 투표를 시작할 수 있어요.';
  end if;
  if room.current_game is null then
    raise exception '진행 중인 게임이 없어요.';
  end if;
  if room.phase not in ('hint', 'discussion') then
    raise exception '힌트 또는 채팅 단계에서만 즉시 투표할 수 있어요.';
  end if;

  room := ww_set_phase(room, 'vote', 30, null, '{}'::jsonb);
  return ww_room_state(room, p_player_id);
end;
$$;

grant execute on function ww_force_vote(text, uuid) to anon;
