"/api/private-tutor-bookings/:bookingId", updatePrivateTutorBooking);



// ══════════════════════════════════════════════════════════════
// نظام الدروس المباشرة: WebRTC signaling + chat + recordings
// الفيديو ينتقل مباشرة بين الطرفين عبر WebRTC، والسيرفر يمرر الإشارات فقط.
// ══════════════════════════════════════════════════════════════
const tutorRoomClients=new Map();
const tutorRoomParticipants=new Map();
const tutorId=()=>"ROOM-"+randomBytes(12).toString("hex");
const tutorMsgId=()=>"MSG-"+randomBytes(12).toString("hex");
const tutorRecId=()=>"REC-"+randomBytes(12).toString("hex");
const participantId=()=>"P-"+randomBytes(10).toString("hex");
function tutorAdmin(u){return !!(u&&(u.is_admin||u.is_super_admin||u.is_moderator||u.email===process.env.ADMIN_EMAIL));}
function sseRoom(res,event,data){try{res.write("event: "+event+"\ndata: "+JSON.stringify(data)+"\n\n");return true;}catch{return false;}}
function emitRoom(room,event,data,except){const m=tutorRoomClients.get(room);if(!m)return;for(const [id,res] of m){if(id!==except&&!sseRoom(res,event,data))m.delete(id);}}
function roomView(r){return {id:r.id,tutorId:r.tutor_id,bookingId:r.booking_id||null,groupSlotId:r.group_slot_id||null,studentEmail:r.student_email,tutorEmail:r.tutor_email||"",status:r.status,startedAt:Number(r.started_at)||0,endedAt:Number(r.ended_at)||0,createdAt:Number(r.created_at)||0};}
async function notifyPrivateTutorRoom(room,tutor,waiting){
  if(!room?.student_email||!room?.booking_id)return false;
  const state=waiting?"waiting":"ready";
  const actionUrl=`tutor-live:${room.tutor_id}:${room.booking_id}:${room.id}:${state}`;
  const tutorName=String(tutor?.name||"المعلم");
  const message=waiting
    ? `المعلم ${tutorName} بانتظارك الآن في المحاضرة المباشرة.`
    : `أنشأ المعلم ${tutorName} محاضرة مباشرة وأرسل لك دعوة للانضمام.`;
  const inserted=await db.query(
    `INSERT INTO notifications (id,user_email,message,type,action_url,created_at)
     SELECT $1,$2,$3,$4,$5,$6
     WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE action_url=$5)
     RETURNING id`,
    [randomBytes(12).toString("hex"),String(room.student_email).toLowerCase(),message,waiting?"tutor_live_waiting":"tutor_live_invitation",actionUrl,Date.now()]
  );
  if(inserted.rows.length&&waiting){
    const siteUrl=tutorEmailHtmlText(String(process.env.PUBLIC_SITE_URL||process.env.FRONTEND_URL||"https://aplus.blog").replace(/\/$/,""));
    const safeTutorName=tutorEmailHtmlText(tutorName);
    notifyTutorByEmail(
      String(room.student_email).toLowerCase(),
      "المعلم بانتظارك في المحاضرة",
      "محاضرتك المباشرة جاهزة",
      `المعلم ${safeTutorName} بانتظارك الآن. افتح منصة A+ على ${siteUrl} وسجّل الدخول للانضمام إلى المحاضرة.`
    ).catch(error=>console.error("private tutor invitation email:",error.message));
  }
  return inserted.rows.length>0;
}
async function tutorAccess(req,tutor){
  const user=await privateTutorUser(req);if(!user)return {user:null,role:null,tutor:null};
  const q=await db.query("SELECT * FROM private_tutors WHERE id=$1 AND active=TRUE LIMIT 1",[tutor]);const row=q.rows[0]||null;
  if(!row)return {user,role:null,tutor:null};
  if(tutorAdmin(user))return {user,role:"admin",tutor:row};
  if(row.tutor_email&&String(row.tutor_email).toLowerCase()===String(user.email).toLowerCase())return {user,role:"tutor",tutor:row};
  const access=await tutorPaymentPlan(tutor,String(user.email).toLowerCase());
  if(access.active)return {user,role:"student",tutor:row};
  const booking=await db.query(
    `SELECT 1 FROM private_tutor_bookings
     WHERE tutor_id=$1 AND student_email=$2 AND status IN ('pending','confirmed')
     ORDER BY created_at DESC LIMIT 1`,
    [tutor,String(user.email).toLowerCase()]
  );
  return {user,role:booking.rows.length?"student":null,tutor:row};
}
async function roomAccess(req,id){
  const q=await db.query("SELECT * FROM private_tutor_rooms WHERE id=$1 LIMIT 1",[id]);const room=q.rows[0]||null;
  if(!room)return {room:null,user:null,role:null,tutor:null};
  const a=await tutorAccess(req,room.tutor_id);
  if(a.user&&room.group_slot_id&&a.role!=="tutor"&&a.role!=="admin"){
    const member=await db.query(
      `SELECT 1 FROM private_tutor_group_bookings b
       JOIN private_tutor_group_slots s ON s.id=b.slot_id
       WHERE b.slot_id=$1 AND lower(b.student_email)=lower($2)
         AND b.status='confirmed' AND s.status='open' LIMIT 1`,
      [room.group_slot_id,String(a.user.email||"")]
    );
    if(member.rows.length)a.role="student";
    else a.role=null;
  }else if(a.role==="student"&&String(a.user.email||"").toLowerCase()!==String(room.student_email||"").toLowerCase()){
    return {room,user:a.user,role:null,tutor:a.tutor};
  }
  return {...a,room};
}

function tutorGroupSlotIsFuture(date,time,leadMinutes){
  const parts=new Intl.DateTimeFormat("en-CA",{
    timeZone:"Asia/Amman",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",hourCycle:"h23"
  }).formatToParts(new Date(Date.now()+Math.max(0,Number(leadMinutes)||0)*60000));
  const now=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return String(date)+"T"+String(time) >= `${now.year}-${now.month}-${now.day}T${now.hour}:${now.minute}`;
}

function validTutorGroupSlot(date,time,duration,capacity){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date||""))||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(time||"")))return false;
  const parsed=new Date(String(date)+"T12:00:00Z");
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===date&&
    Number.isInteger(Number(duration))&&Number(duration)>=15&&Number(duration)<=240&&
    Number.isInteger(Number(capacity))&&Number(capacity)>=2&&Number(capacity)<=6;
}

app.get("/api/private-tutors/:id/group-slots",async(req,res)=>{
  try{
    const tutorId=String(req.params.id||"");
    const from=String(req.query.from||new Date().toISOString().slice(0,10));
    const to=String(req.query.to||new Date(Date.now()+60*86400000).toISOString().slice(0,10));
    if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to))return res.status(400).json({ok:false,msg:"نطاق التاريخ غير صالح"});
    const user=await privateTutorUser(req);
    const q=await db.query(
      `SELECT s.id,s.session_date,s.start_time,s.duration_minutes,s.capacity,s.status,
        COUNT(b.id) FILTER(WHERE b.status='confirmed')::int AS booked_count,
        BOOL_OR(lower(b.student_email)=lower($4)) FILTER(WHERE b.status='confirmed') AS booked_by_me
       FROM private_tutor_group_slots s
       LEFT JOIN private_tutor_group_bookings b ON b.slot_id=s.id
       WHERE s.tutor_id=$1 AND s.status='open' AND s.session_date >= $2 AND s.session_date <= $3
       GROUP BY s.id
       ORDER BY s.session_date,s.start_time`,
      [tutorId,from,to,String(user?.email||"").toLowerCase()]
    );
    res.json({ok:true,slots:q.rows.map(x=>({
      id:x.id,date:x.session_date,time:String(x.start_time).slice(0,5),
      durationMinutes:Number(x.duration_minutes)||60,capacity:Number(x.capacity)||5,
      bookedCount:Number(x.booked_count)||0,
      seatsRemaining:Math.max(0,Number(x.capacity||0)-Number(x.booked_count||0)),
      bookedByMe:!!x.booked_by_me
    })).filter(x=>tutorGroupSlotIsFuture(x.date,x.time,0))});
  }catch(e){console.error("group slots list:",e.message);res.status(500).json({ok:false,slots:[]});}
});

app.get("/api/private-tutors/:id/group-slots/manage",async(req,res)=>{
  try{
    const access=await tutorAccess(req,String(req.params.id||""));
    if(!access.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
    if(access.role!=="tutor"&&access.role!=="admin")return res.status(403).json({ok:false,msg:"هذه الصفحة للمعلم فقط"});
    const slots=await db.query(
      `SELECT s.id,s.session_date,s.start_time,s.duration_minutes,s.capacity,s.status,s.created_at,
        COUNT(b.id) FILTER(WHERE b.status='confirmed')::int AS booked_count,
        r.id AS room_id,r.status AS room_status
       FROM private_tutor_group_slots s
       LEFT JOIN private_tutor_group_bookings b ON b.slot_id=s.id
       LEFT JOIN private_tutor_rooms r ON r.group_slot_id=s.id AND r.status IN ('waiting','active')
       WHERE s.tutor_id=$1
       GROUP BY s.id,r.id
       ORDER BY s.session_date DESC,s.start_time DESC LIMIT 100`,
      [String(req.params.id||"")]
    );
    const bookings=await db.query(
      `SELECT b.id,b.slot_id,b.student_email,b.status,b.created_at,u.full_name,
              s.session_date,s.start_time
       FROM private_tutor_group_bookings b
       JOIN private_tutor_group_slots s ON s.id=b.slot_id
       LEFT JOIN users u ON lower(u.email)=lower(b.student_email)
       WHERE b.tutor_id=$1 AND b.status='confirmed'
       ORDER BY s.session_date,s.start_time,b.created_at`,
      [String(req.params.id||"")]
    );
    res.json({ok:true,slots:slots.rows.map(x=>({
      id:x.id,date:x.session_date,time:String(x.start_time).slice(0,5),
      durationMinutes:Number(x.duration_minutes)||60,capacity:Number(x.capacity)||5,
      bookedCount:Number(x.booked_count)||0,status:x.status,roomId:x.room_id||"",
      roomStatus:x.room_status||""
    })),bookings:bookings.rows.map(x=>({
      id:x.id,slotId:x.slot_id,studentEmail:x.student_email,
      studentName:x.full_name||"طالب",status:x.status,date:x.session_date,
      time:String(x.start_time).slice(0,5)
    }))});
  }catch(e){console.error("group slots manage:",e.message);res.status(500).json({ok:false,msg:"تعذر تحميل مواعيد الحصص"});}
});

app.post("/api/private-tutors/:id/group-slots",async(req,res)=>{
  try{
    const access=await tutorAccess(req,String(req.params.id||""));
    if(!access.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
    if(access.role!=="tutor"&&access.role!=="admin")return res.status(403).json({ok:false,msg:"هذه الصفحة للمعلم فقط"});
    const date=String(req.body?.date||"").slice(0,10),time=String(req.body?.time||"").slice(0,5);
    const duration=Number(req.body?.durationMinutes)||60,capacity=Number(req.body?.capacity)||5;
    if(!validTutorGroupSlot(date,time,duration,capacity))return res.status(400).json({ok:false,msg:"تحقق من التاريخ والوقت والسعة (طالبان إلى 6 طلاب)"});
    if(!tutorGroupSlotIsFuture(date,time,5))return res.status(400).json({ok:false,msg:"اختر موعداً يبدأ بعد خمس دقائق"});
    const id=privateTutorId(),now=Date.now(),tutorId=String(req.params.id||"");
    const q=await withDbTransaction(async client=>{
      await client.query("SELECT id FROM private_tutors WHERE id=$1 FOR UPDATE",[tutorId]);
      if(await hasActiveIndividualBookingAt(client,tutorId,date,time))
        throw Object.assign(new Error("appointment_conflict"),{code:"GROUP_BOOKING_CONFLICT"});
      return client.query(
        `INSERT INTO private_tutor_group_slots
         (id,tutor_id,session_date,start_time,duration_minutes,capacity,status,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,'open',$7,$7) RETURNING *`,
        [id,tutorId,date,time,duration,capacity,now]
      );
    });
    res.status(201).json({ok:true,slot:{id:q.rows[0].id,date:q.rows[0].session_date,time:String(q.rows[0].start_time).slice(0,5),durationMinutes:duration,capacity}});
  }catch(e){
    if(e.code==="GROUP_BOOKING_CONFLICT")return res.status(409).json({ok:false,msg:"يوجد حجز فردي بهذا الوقت؛ اختر وقتاً آخر"});
    if(e.code==="23505")return res.status(409).json({ok:false,msg:"لديك حصة أخرى بهذا الموعد"});
    console.error("group slot create:",e.message);res.status(500).json({ok:false,msg:"تعذر إضافة الموعد"});
  }
});

app.patch("/api/private-tutor/group-slots/:slotId",async(req,res)=>{
  try{
    const slotId=String(req.params.slotId||"");
    const found=await db.query("SELECT * FROM private_tutor_group_slots WHERE id=$1 LIMIT 1",[slotId]);
    if(!found.rows.length)return res.status(404).json({ok:false,msg:"الموعد غير موجود"});
    const slot=found.rows[0],access=await tutorAccess(req,slot.tutor_id);
    if(!access.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
    if(access.role!=="tutor"&&access.role!=="admin")return res.status(403).json({ok:false,msg:"غير مصرح"});
    const date=String(req.body?.date||slot.session_date).slice(0,10);
    const time=String(req.body?.time||slot.start_time).slice(0,5);
    const duration=Number(req.body?.durationMinutes)||Number(slot.duration_minutes)||60;
    const capacity=Number(req.body?.capacity)||Number(slot.capacity)||5;
    if(!validTutorGroupSlot(date,time,duration,capacity))return res.status(400).json({ok:false,msg:"تحقق من التاريخ والوقت والسعة (طالبان إلى 6 طلاب)"});
    if(!tutorGroupSlotIsFuture(date,time,5))return res.status(400).json({ok:false,msg:"اختر موعداً يبدأ بعد خمس دقائق"});
    const result=await withDbTransaction(async client=>{
      await client.query("SELECT id FROM private_tutors WHERE id=$1 FOR UPDATE",[slot.tutor_id]);
      const locked=await client.query("SELECT * FROM private_tutor_group_slots WHERE id=$1 FOR UPDATE",[slotId]);
      if(!locked.rows.length)return null;
      const current=locked.rows[0];
      if(await hasActiveIndividualBookingAt(client,slot.tutor_id,date,time))
        throw Object.assign(new Error("appointment_conflict"),{code:"GROUP_BOOKING_CONFLICT"});
      const room=await client.query("SELECT status FROM private_tutor_rooms WHERE group_slot_id=$1 AND status IN ('waiting','active') LIMIT 1",[slotId]);
      if(room.rows.length)throw Object.assign(new Error("room_active"),{code:"GROUP_ROOM_ACTIVE"});
      const count=await client.query("SELECT COUNT(*)::int AS n FROM private_tutor_group_bookings WHERE slot_id=$1 AND status='confirmed'",[slotId]);
      if(capacity<Number(count.rows[0]?.n||0))throw Object.assign(new Error("capacity_below_bookings"),{code:"GROUP_CAPACITY_LOW"});
      const duplicate=await client.query("SELECT id FROM private_tutor_group_slots WHERE tutor_id=$1 AND id<>$2 AND session_date=$3 AND start_time=$4 AND status='open' LIMIT 1",[slot.tutor_id,slotId,date,time]);
      if(duplicate.rows.length)throw Object.assign(new Error("duplicate"),{code:"GROUP_SLOT_DUPLICATE"});
      return client.query("UPDATE private_tutor_group_slots SET session_date=$1,start_time=$2,duration_minutes=$3,capacity=$4,updated_at=$5 WHERE id=$6 RETURNING *",[date,time,duration,capacity,Date.now(),slotId]);
    });
    if(!result)return res.status(404).json({ok:false,msg:"الموعد غير موجود"});
    if(date!==slot.session_date||time!==String(slot.start_time).slice(0,5)){
      const note=`غيّر المعلم موعد الحصة الجماعية إلى ${date} الساعة ${time}.`;
      const members=await db.query("SELECT student_email FROM private_tutor_group_bookings WHERE slot_id=$1 AND status='confirmed'",[slotId]);
      await Promise.all(members.rows.map(member=>db.query("INSERT INTO notifications(id,user_email,message,type,created_at) VALUES($1,$2,$3,'tutor_group_slot',$4)",[randomBytes(12).toString("hex"),member.student_email,note,Date.now()]).catch(()=>{})));
    }
    res.json({ok:true,slot:{id:slotId,date,time,durationMinutes:duration,capacity}});
  }catch(e){
    if(e.code==="GROUP_BOOKING_CONFLICT")return res.status(409).json({ok:false,msg:"يوجد حجز فردي بهذا الوقت؛ اختر وقتاً آخر"});
    if(e.code==="GROUP_ROOM_ACTIVE")return res.status(409).json({ok:false,msg:"لا يمكن تعديل الموعد أثناء وجود محاضرة مباشرة"});
    if(e.code==="GROUP_CAPACITY_LOW")return res.status(409).json({ok:false,msg:"السعة أقل من عدد الطلاب المسجلين"});
    if(e.code==="GROUP_SLOT_DUPLICATE"||e.code==="23505")return res.status(409).json({ok:false,msg:"لديك حصة أخرى بهذا الموعد"});
    console.error("group slot update:",e.message);res.status(500).json({ok:false,msg:"تعذر تعديل الموعد"});
  }
});

app.delete("/api/private-tutor/group-slots/:slotId",async(req,res)=>{
  try{
    const slotId=String(req.params.slotId||"");
    const found=await db.query("SELECT * FROM private_tutor_group_slots WHERE id=$1 LIMIT 1",[slotId]);
    if(!found.rows.length)return res.status(404).json({ok:false,msg:"الموعد غير موجود"});
    const slot=found.rows[0],access=await tutorAccess(req,slot.tutor_id);
    if(!access.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
    if(access.role!=="tutor"&&access.role!=="admin")return res.status(403).json({ok:false,msg:"غير مصرح"});
    const room=await db.query("SELECT id FROM private_tutor_rooms WHERE group_slot_id=$1 AND status IN ('waiting','active') LIMIT 1",[slotId]);
    if(room.rows.length)return res.status(409).json({ok:false,msg:"أنه المحاضرة المباشرة قبل إلغاء الموعد"});
    const members=await db.query("SELECT student_email FROM private_tutor_group_bookings WHERE slot_id=$1 AND status='confirmed'",[slotId]);
    await withDbTransaction(async client=>{
      await client.query("UPDATE private_tutor_group_slots SET status='cancelled',updated_at=$1 WHERE id=$2",[Date.now(),slotId]);
      await client.query("UPDATE private_tutor_group_bookings SET status='cancelled' WHERE slot_id=$1 AND status='confirmed'",[slotId]);
    });
    await Promise.all(members.rows.map(member=>db.query("INSERT INTO notifications(id,user_email,message,type,created_at) VALUES($1,$2,$3,'tutor_group_slot',$4)",[randomBytes(12).toString("hex"),member.student_email,"ألغى المعلم الحصة الجماعية. اختر موعداً آخر.",Date.now()]).catch(()=>{})));
    res.json({ok:true});
  }catch(e){console.error("group slot delete:",e.message);res.status(500).json({ok:false,msg:"تعذر إلغاء الموعد"});}
});

app.post("/api/private-tutor/group-slots/:slotId/bookings",async(req,res)=>{
  try{
    const user=await privateTutorUser(req);
    if(!user||user.banned)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
    const slotId=String(req.params.slotId||""),studentEmail=String(user.email||"").toLowerCase();
    const initial=await db.query(
      `SELECT s.tutor_id,COALESCE(t.free_access,FALSE) AS free_access
       FROM private_tutor_group_slots s
       JOIN private_tutors t ON t.id=s.tutor_id
       WHERE s.id=$1 AND s.status='open' AND t.active=TRUE
         AND COALESCE(t.verification_status,'approved')='approved'
       LIMIT 1`,
      [slotId]
    );
    if(!initial.rows.length)return res.status(404).json({ok:false,msg:"الموعد غير متاح"});
    if(!initial.rows[0].free_access){
      const entitlement=await tutorPaymentPlan(initial.rows[0].tutor_id,studentEmail);
      if(!entitlement.active)return res.status(403).json({ok:false,msg:"فعّل اشتراكك مع المعلم قبل الحجز"});
    }
    const result=await withDbTransaction(async client=>{
      const q=await client.query("SELECT * FROM private_tutor_group_slots WHERE id=$1 AND status='open' FOR UPDATE",[slotId]);
      if(!q.rows.length)throw Object.assign(new Error("unavailable"),{code:"GROUP_SLOT_UNAVAILABLE"});
      const slot=q.rows[0];
      if(!tutorGroupSlotIsFuture(slot.session_date,String(slot.start_time).slice(0,5),5))throw Object.assign(new Error("past"),{code:"GROUP_SLOT_PAST"});
      const existing=await client.query("SELECT id,status FROM private_tutor_group_bookings WHERE slot_id=$1 AND lower(student_email)=lower($2) LIMIT 1",[slotId,studentEmail]);
      if(existing.rows.length&&existing.rows[0].status==="confirmed")throw Object.assign(new Error("already booked"),{code:"GROUP_ALREADY_BOOKED"});
      const count=await client.query("SELECT COUNT(*)::int AS n FROM private_tutor_group_bookings WHERE slot_id=$1 AND status='confirmed'",[slotId]);
      if(Number(count.rows[0]?.n||0)>=Number(slot.capacity))throw Object.assign(new Error("full"),{code:"GROUP_SLOT_FULL"});
      const bookingId=existing.rows[0]?.id||privateTutorId();
      if(existing.rows.length)await client.query("UPDATE private_tutor_group_bookings SET status='confirmed' WHERE id=$1",[bookingId]);
      else await client.query("INSERT INTO private_tutor_group_bookings(id,slot_id,tutor_id,student_email,status,created_at) VALUES($1,$2,$3,$4,'confirmed',$5)",[bookingId,slotId,slot.tutor_id,studentEmail,Date.now()]);
      return {bookingId,slot};
    });
    const tutor=await db.query("SELECT tutor_email,name FROM private_tutors WHERE id=$1 LIMIT 1",[result.slot.tutor_id]);
    if(tutor.rows[0]?.tutor_email)await db.query("INSERT INTO notifications(id,user_email,message,type,created_at) VALUES($1,$2,$3,'tutor_group_booking',$4)",[randomBytes(12).toString("hex"),tutor.rows[0].tutor_email,`حجز طالب مقعداً في حصتك الجماعية بتاريخ ${result.slot.session_date} الساعة ${String(result.slot.start_time).slice(0,5)}.`,Date.now()]).catch(()=>{});
    res.status(201).json({ok:true,booking:{id:result.bookingId,slotId,date:result.slot.session_date,time:String(result.slot.start_time).slice(0,5)}});
  }catch(e){
    if(e.code==="GROUP_SLOT_UNAVAILABLE")return res.status(404).json({ok:false,msg:"الموعد غير متاح"});
    if(e.code==="GROUP_SLOT_PAST")return res.status(409).json({ok:false,msg:"انتهى وقت الحجز"});
    if(e.code==="GROUP_ALREADY_BOOKED")return res.status(409).json({ok:false,msg:"أنت حجزت هذا الموعد مسبقاً"});
    if(e.code==="GROUP_SLOT_FULL")return res.status(409).json({ok:false,msg:"اكتمل عدد الطلاب؛ اختر موعداً آخر"});
    console.error("group booking:",e.message);res.status(500).json({ok:false,msg:"تعذر حجز المقعد"});
  }
});

app.get("/api/private-tutors/:id/group-bookings/mine",async(req,res)=>{
  try{
    const user=await privateTutorUser(req);
    if(!user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
    const q=await db.query(
      `SELECT b.id,b.slot_id,b.status,s.session_date,s.start_time,s.duration_minutes,
              r.id AS room_id,t.name AS tutor_name,t.subject
       FROM private_tutor_group_bookings b
       JOIN private_tutor_group_slots s ON s.id=b.slot_id
       JOIN private_tutors t ON t.id=b.tutor_id
       LEFT JOIN private_tutor_rooms r ON r.group_slot_id=s.id AND r.status IN ('waiting','active')
       WHERE b.tutor_id=$1 AND lower(b.student_email)=lower($2)
       ORDER BY s.session_date DESC,s.start_time DESC LIMIT 50`,
      [String(req.params.id||""),String(user.email||"").toLowerCase()]
    );
    res.json({ok:true,bookings:q.rows.map(x=>({id:x.id,slotId:x.slot_id,status:x.status,date:x.session_date,time:String(x.start_time).slice(0,5),durationMinutes:Number(x.duration_minutes)||60,roomId:x.room_id||"",tutorName:x.tutor_name||"المعلم",subject:x.subject||""}))});
  }catch(e){console.error("student group bookings:",e.message);res.status(500).json({ok:false,bookings:[]});}
});

app.get("/api/private-tutor/group-invitations",async(req,res)=>{
  try{
    const user=await privateTutorUser(req);
    if(!user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
    const q=await db.query(
      `SELECT r.id AS room_id,s.id AS slot_id,s.tutor_id,s.session_date,s.start_time,
              t.name AS tutor_name,t.subject,t.tutor_email
       FROM private_tutor_rooms r
       JOIN private_tutor_group_slots s ON s.id=r.group_slot_id AND s.status='open'
       JOIN private_tutor_group_bookings b ON b.slot_id=s.id AND b.status='confirmed'
       JOIN private_tutors t ON t.id=s.tutor_id AND t.active=TRUE
       WHERE lower(b.student_email)=lower($1) AND r.status IN ('waiting','active')
       ORDER BY r.created_at DESC LIMIT 20`,
      [String(user.email||"").toLowerCase()]
    );
    res.json({ok:true,invitations:q.rows.map(x=>({
      roomId:x.room_id,slotId:x.slot_id,tutorId:x.tutor_id,tutorName:x.tutor_name||"المعلم",
      subject:x.subject||"",requestedDate:x.session_date,requestedTime:String(x.start_time).slice(0,5),
      teacherOnline:[...(tutorRoomParticipants.get(String(x.room_id))||new Map()).values()].some(p=>p.approved&&p.role==="tutor"&&String(p.email||"").toLowerCase()===String(x.tutor_email||"").toLowerCase())
    }))});
  }catch(e){console.error("group invitations:",e.message);res.status(500).json({ok:false,invitations:[]});}
});

app.post("/api/private-tutor/group-slots/:slotId/room",async(req,res)=>{
  try{
    const slotId=String(req.params.slotId||"");
    const q=await db.query("SELECT * FROM private_tutor_group_slots WHERE id=$1 AND status='open' LIMIT 1",[slotId]);
    if(!q.rows.length)return res.status(404).json({ok:false,msg:"الحصة غير موجودة"});
    const slot=q.rows[0],access=await tutorAccess(req,slot.tutor_id);
    if(!access.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
    if(access.role!=="tutor"&&access.role!=="admin")return res.status(403).json({ok:false,msg:"المعلم فقط يبدأ الحصة"});
    const seats=await db.query("SELECT COUNT(*)::int AS n FROM private_tutor_group_bookings WHERE slot_id=$1 AND status='confirmed'",[slotId]);
    if(!Number(seats.rows[0]?.n))return res.status(409).json({ok:false,msg:"لا يوجد طلاب حجزوا هذه الحصة"});
    const result=await withDbTransaction(async client=>{
      await client.query("SELECT id FROM private_tutors WHERE id=$1 FOR UPDATE",[slot.tutor_id]);
      await client.query("SELECT id FROM private_tutor_group_slots WHERE id=$1 FOR UPDATE",[slotId]);
      const existing=await client.query("SELECT * FROM private_tutor_rooms WHERE group_slot_id=$1 AND status IN ('waiting','active') ORDER BY created_at DESC LIMIT 1",[slotId]);
      if(existing.rows.length)return {room:existing.rows[0],created:false};
      const roomId=privateTutorId();
      const room=await client.query(
        `INSERT INTO private_tutor_rooms(id,tutor_id,booking_id,group_slot_id,student_email,tutor_email,status,created_at)
         VALUES($1,$2,NULL,$3,'',$4,'waiting',$5) RETURNING *`,
        [roomId,slot.tutor_id,slotId,slot.tutor_email||"",Date.now()]
      );
      return {room:room.rows[0],created:true};
    });
    if(result.created){
      void (async()=>{
        const members=await db.query("SELECT student_email FROM private_tutor_group_bookings WHERE slot_id=$1 AND status='confirmed'",[slotId]);
        await Promise.all(members.rows.map(member=>db.query(
          `INSERT INTO notifications(id,user_email,message,type,action_url,created_at)
           VALUES($1,$2,$3,'tutor_group_live',$4,$5)`,
          [randomBytes(12).toString("hex"),member.student_email,`بدأ المعلم ${access.tutor.name||"المعلم"} الحصة الجماعية.`, `tutor-group-live:${slotId}:${result.room.id}`,Date.now()]
        ).catch(()=>{})));
      })().catch(error=>console.error("group room invitations:",error.message));
    }
    res.status(result.created?201:200).json({ok:true,room:roomView(result.room)});
  }catch(e){console.error("group room start:",e.message);res.status(500).json({ok:false,msg:"تعذر بدء الحصة الجماعية"});}
});

app.get("/api/private-tutor/student-invitations",async(req,res)=>{
  try{
    const user=await privateTutorUser(req);
    if(!user||user.banned)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
    const q=await db.query(
      `SELECT r.id AS room_id,r.tutor_id,r.booking_id,r.status,r.created_at,
              r.tutor_email,t.name AS tutor_name,t.subject,
              b.requested_date,b.requested_time,b.proposed_date,b.proposed_time
       FROM private_tutor_rooms r
       JOIN private_tutors t ON t.id=r.tutor_id AND t.active=TRUE
       JOIN private_tutor_bookings b ON b.id=r.booking_id AND b.status='confirmed'
       WHERE lower(r.student_email)=lower($1) AND r.status IN ('waiting','active')
       ORDER BY r.created_at DESC LIMIT 20`,
      [String(user.email||"").toLowerCase()]
    );
    const invitations=q.rows.map(row=>{
      const participants=tutorRoomParticipants.get(String(row.room_id))||new Map();
      const teacherOnline=[...participants.values()].some(participant=>
        participant.approved&&participant.role==="tutor"&&
        String(participant.email||"").toLowerCase()===String(row.tutor_email||"").toLowerCase()
      );
      return {
        roomId:row.room_id,tutorId:row.tutor_id,bookingId:row.booking_id,
        tutorName:row.tutor_name||"المعلم",subject:row.subject||"",
        requestedDate:row.proposed_date||row.requested_date||"",
        requestedTime:row.proposed_time||row.requested_time||"",
        teacherWaiting:true,teacherOnline,createdAt:Number(row.created_at)||0
      };
    }).filter(invitation=>invitation&&invitation.teacherOnline);
    res.json({ok:true,invitations});
  }catch(e){console.error("private tutor student invitations:",e.message);res.status(500).json({ok:false,invitations:[]});}
});

app.post("/api/private-tutors/:id/rooms",async(req,res)=>{
  try{
    const a=await tutorAccess(req,String(req.params.id||""));
    if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
    if(!a.role)return res.status(403).json({ok:false,msg:"فعّل اشتراك المعلم أولاً"});
    const student=a.role==="student"?String(a.user.email).toLowerCase():String(req.body?.studentEmail||"").toLowerCase().trim();
    if(!student||!student.includes("@"))return res.status(400).json({ok:false,msg:"studentEmail مطلوب"});
    const booking=req.body?.bookingId?String(req.body.bookingId).slice(0,120):null;
    if(!booking)return res.status(400).json({ok:false,msg:"لا يمكن فتح محاضرة بدون حجز مؤكد"});
    const b=await db.query(
      "SELECT student_email,status FROM private_tutor_bookings WHERE id=$1 AND tutor_id=$2 LIMIT 1",
      [booking,a.tutor.id]
    );
    if(!b.rows.length)return res.status(404).json({ok:false,msg:"الحجز غير موجود"});
    if(b.rows[0].status!=="confirmed")return res.status(403).json({ok:false,msg:"الحجز لم يتم تأكيده بعد"});
    const bookingStudent=String(b.rows[0].student_email||"").toLowerCase();
    if(bookingStudent!==student)return res.status(403).json({ok:false,msg:"الطالب غير مطابق للحجز"});
    if(a.role==="student"){
      const existing=await db.query(
        "SELECT * FROM private_tutor_rooms WHERE booking_id=$1 AND status IN ('waiting','active') ORDER BY created_at DESC LIMIT 1",
        [booking]
      );
      const room=existing.rows[0];
      const participants=room?tutorRoomParticipants.get(String(room.id))||new Map():new Map();
      const tutorOnline=room&&[...participants.values()].some(participant=>
        participant.approved&&participant.role==="tutor"&&
        String(participant.email||"").toLowerCase()===String(room.tutor_email||"").toLowerCase()
      );
      if(!room||!tutorOnline)return res.status(409).json({ok:false,msg:"لا توجد محاضرة مباشرة الآن."});
      return res.json({ok:true,room:roomView(room),eventsUrl:"/api/private-tutor-rooms/"+room.id+"/events"});
    }
    const now=Date.now();
    const result=await withDbTransaction(async client=>{
      const locked=await client.query("SELECT id FROM private_tutor_bookings WHERE id=$1 AND tutor_id=$2 FOR UPDATE",[booking,a.tutor.id]);
      if(!locked.rows.length)return null;
      const existing=await client.query("SELECT * FROM private_tutor_rooms WHERE booking_id=$1 AND status IN ('waiting','active') ORDER BY created_at DESC LIMIT 1",[booking]);
      if(existing.rows.length)return {room:existing.rows[0],created:false};
      const id=privateTutorId();
      const created=await client.query(
        "INSERT INTO private_tutor_rooms (id,tutor_id,booking_id,student_email,tutor_email,status,created_at) VALUES ($1,$2,$3,$4,$5,'waiting',$6) RETURNING *",
        [id,a.tutor.id,booking,student,a.tutor.tutor_email||"",now]
      );
      return {room:created.rows[0],created:true};
    });
    if(!result)return res.status(404).json({ok:false,msg:"الحجز غير موجود"});
    if(a.role==="tutor"||a.role==="admin"){
      void notifyPrivateTutorRoom(result.room,a.tutor,false).catch(error=>console.error("private tutor room notification:",error.message));
    }
    const roomId=result.room.id;
    res.status(result.created?201:200).json({ok:true,room:roomView(result.room),eventsUrl:"/api/private-tutor-rooms/"+roomId+"/events"});
  }catch(e){console.error("room create",e.message);res.status(500).json({ok:false,msg:"تعذر إنشاء الغرفة"});}
});

app.get("/api/private-tutors/:id/manage-bookings",async(req,res)=>{
  try{
    const a=await tutorAccess(req,String(req.params.id||""));
    if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
     if(a.role!=="tutor")return res.status(403).json({ok:false,msg:"هذه الصفحة للمعلم فقط"});
    const q=await db.query(
       `SELECT b.*,u.full_name, r.id AS room_id,t.zoom_url AS tutor_zoom_url
       FROM private_tutor_bookings b
        JOIN private_tutors t ON t.id=b.tutor_id
       LEFT JOIN users u ON lower(u.email)=lower(b.student_email)
       LEFT JOIN private_tutor_rooms r ON r.booking_id=b.id
       WHERE b.tutor_id=$1 AND b.status IN ('pending','confirmed','proposed')
       ORDER BY b.created_at DESC LIMIT 100`,
      [String(req.params.id||"")]
    );
    res.json({ok:true,bookings:q.rows.map(b=>({
      id:b.id,studentEmail:b.student_email,studentName:b.full_name||"طالب",
      requestedDate:b.requested_date||"",requestedTime:b.requested_time||"",
      dayOfWeek:b.day_of_week,timeText:b.time_text,proposedDate:b.proposed_date||"",
      proposedTime:b.proposed_time||"",responseNote:b.response_note||"",
       notes:b.notes||"",status:b.status,roomId:b.room_id||"",
       zoomUrl:b.zoom_url||b.tutor_zoom_url||""
    }))});
  }catch(e){res.status(500).json({ok:false,msg:"تعذر تحميل حجوزات المعلم"});}
});

app.get("/api/private-tutor-rooms/:roomId",async(req,res)=>{try{const a=await roomAccess(req,String(req.params.roomId));if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room)return res.status(404).json({ok:false,msg:"الغرفة غير موجودة"});if(!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});res.json({ok:true,room:roomView(a.room)});}catch(e){res.status(500).json({ok:false,msg:"تعذر تحميل الغرفة"});}});

app.post("/api/private-tutor-rooms/:roomId/join",async(req,res)=>{try{
  const id=String(req.params.roomId),a=await roomAccess(req,id);if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room)return res.status(404).json({ok:false,msg:"الغرفة غير موجودة"});if(!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});
  if(a.room.status==="ended")return res.status(410).json({ok:false,msg:"انتهت المحاضرة"});
  if(a.role==="student"){
    const tutorEmail=String(a.room.tutor_email||a.tutor?.tutor_email||"").toLowerCase();
    const tutorOnline=[...(tutorRoomParticipants.get(id)||new Map()).values()].some(participant=>
      participant.approved&&participant.role==="tutor"&&
      (!tutorEmail||String(participant.email||"").toLowerCase()===tutorEmail)
    );
    if(!tutorOnline)return res.status(409).json({ok:false,msg:"لا توجد محاضرة مباشرة الآن."});
  }
  let scheduledDate="",scheduledTime="";
  if(a.room.booking_id){
    const schedule=await db.query(
      "SELECT COALESCE(NULLIF(proposed_date,''),requested_date,'') AS date,COALESCE(NULLIF(proposed_time,''),requested_time,'') AS time FROM private_tutor_bookings WHERE id=$1 LIMIT 1",
      [a.room.booking_id]
    );
    scheduledDate=String(schedule.rows[0]?.date||"");
    scheduledTime=String(schedule.rows[0]?.time||"").slice(0,5);
  }else if(a.room.group_slot_id){
    const schedule=await db.query(
      "SELECT session_date AS date,start_time AS time FROM private_tutor_group_slots WHERE id=$1 LIMIT 1",
      [a.room.group_slot_id]
    );
    scheduledDate=String(schedule.rows[0]?.date||"");
    scheduledTime=String(schedule.rows[0]?.time||"").slice(0,5);
  }
  if(!tutorRoomParticipants.has(id))tutorRoomParticipants.set(id,new Map());const ps=tutorRoomParticipants.get(id);
  const joinKey=String(req.body?.joinKey||"").slice(0,80);
  const existing=[...ps].find(([,v])=>String(v.email).toLowerCase()===String(a.user.email).toLowerCase());
  if(existing){
    const [existingId,existingParticipant]=existing;
    if(joinKey&&existingParticipant.joinKey===joinKey)return res.json({ok:true,roomId:id,participantId:existingId,role:existingParticipant.role,waiting:!existingParticipant.approved,scheduledDate,scheduledTime,participants:[...ps].map(([participantId,v])=>({participantId,role:v.role,email:v.email,approved:!!v.approved}))});
    return res.status(409).json({ok:false,msg:"أنت داخل المحاضرة من نافذة أخرى"});
  }
   if(a.room.group_slot_id){
     const groupSlot=await db.query("SELECT capacity,status FROM private_tutor_group_slots WHERE id=$1 LIMIT 1",[a.room.group_slot_id]);
     if(!groupSlot.rows.length||groupSlot.rows[0].status!=="open")return res.status(410).json({ok:false,msg:"تم إلغاء الحصة"});
     const studentCount=[...ps.values()].filter(participant=>participant.role==="student").length;
     if(studentCount>=Number(groupSlot.rows[0].capacity||5))return res.status(409).json({ok:false,msg:"اكتمل عدد الطلاب في الحصة"});
   }else if(ps.size>=2)return res.status(409).json({ok:false,msg:"المحاضرة ممتلئة"});
  const p=participantId(),approved=a.role==="tutor"||a.role==="admin";
  ps.set(p,{email:a.user.email,role:a.role,approved,joinKey,joinedAt:Date.now()});
  await db.query("UPDATE private_tutor_rooms SET status='active',started_at=COALESCE(started_at,$1) WHERE id=$2",[Date.now(),id]);
  if(a.role==="tutor"&&!Number(a.room.started_at)){
    notifyPrivateTutorRoom(a.room,a.tutor,true).catch(error=>console.error("private tutor invitation:",error.message));
  }
  emitRoom(id,"participant-joined",{participantId:p,role:a.role,email:a.user.email});
  res.json({ok:true,roomId:id,participantId:p,role:a.role,waiting:!approved,scheduledDate,scheduledTime,participants:[...ps].map(([participantId,v])=>({participantId,role:v.role,email:v.email,approved:!!v.approved}))});
}catch(e){res.status(500).json({ok:false,msg:"تعذر دخول الغرفة"});}});

// اتصال STUN الأساسي يعمل دون إعداد إضافي. للاتصال الموثوق خلف شبكات NAT أضف
// TUTOR_TURN_URLS و TUTOR_TURN_SHARED_SECRET إلى أسرار الخادم (Coturn REST API).
function tutorIceServersFor(user){
  const iceServers=[{urls:"stun:stun.l.google.com:19302"}];
  const urls=String(process.env.TUTOR_TURN_URLS||"").split(",").map(x=>x.trim()).filter(Boolean);
  const secret=String(process.env.TUTOR_TURN_SHARED_SECRET||"");
  if(urls.length&&secret&&user?.email){
    const expires=Math.floor(Date.now()/1000)+3600;
    const username=expires+":"+String(user.email).toLowerCase();
    const credential=createHmac("sha1",secret).update(username).digest("base64");
    iceServers.push({urls,username,credential});
  }
  return iceServers;
}
app.get("/api/private-tutor-rooms/:roomId/ice-servers",async(req,res)=>{try{
  const id=String(req.params.roomId),a=await roomAccess(req,id),p=String(req.query.participantId||"");
  if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
  if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});
  const participant=tutorRoomParticipants.get(id)?.get(p);
  if(!participant||String(participant.email).toLowerCase()!==String(a.user.email).toLowerCase())return res.status(403).json({ok:false,msg:"المشارك غير صالح"});
  const iceServers=tutorIceServersFor(a.user);
  res.json({ok:true,iceServers,turnAvailable:iceServers.length>1});
}catch(e){res.status(500).json({ok:false,msg:"تعذر إعداد اتصال الصوت والصورة"});}});

app.get("/api/private-tutor-rooms/:roomId/events",async(req,res)=>{try{
  const id=String(req.params.roomId),a=await roomAccess(req,id),p=String(req.query.participantId||"");if(!a.user)return res.status(401).end();if(!a.room)return res.status(404).end();if(!a.role)return res.status(403).end();
  const part=tutorRoomParticipants.get(id)?.get(p);if(!part||part.email!==a.user.email)return res.status(403).end();
  res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no","Access-Control-Allow-Origin":"*"});
  if(!tutorRoomClients.has(id))tutorRoomClients.set(id,new Map());const clients=tutorRoomClients.get(id);clients.set(p,res);sseRoom(res,"connected",{roomId:id,participantId:p,role:a.role,approved:!!part.approved});
  emitRoom(id,"presence",{participants:[...(tutorRoomParticipants.get(id)||[])].map(([participantId,v])=>({participantId,role:v.role,email:v.email,approved:!!v.approved}))});
  const close=()=>{clients.delete(p);tutorRoomParticipants.get(id)?.delete(p);emitRoom(id,"participant-left",{participantId:p});};req.on("close",close);req.on("error",close);
}catch(e){if(!res.headersSent)res.status(500).end();}});

app.post("/api/private-tutor-rooms/:roomId/signal",async(req,res)=>{try{
  const id=String(req.params.roomId),a=await roomAccess(req,id),from=String(req.body?.from||""),to=String(req.body?.to||""),type=String(req.body?.type||"");if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});
  const p=tutorRoomParticipants.get(id)?.get(from),target=tutorRoomParticipants.get(id)?.get(to);if(!p||p.email!==a.user.email)return res.status(403).json({ok:false,msg:"مشارك غير صالح"});if(!p.approved||target&&!target.approved)return res.status(403).json({ok:false,msg:"لم يتم السماح بالدخول بعد"});if(!["offer","answer","ice-candidate","renegotiate"].includes(type))return res.status(400).json({ok:false,msg:"إشارة غير صالحة"});
  const data={from,to,type,data:req.body?.data||null},clients=tutorRoomClients.get(id)||new Map();if(to&&clients.has(to))sseRoom(clients.get(to),"webrtc-signal",data);else emitRoom(id,"webrtc-signal",data,from);res.json({ok:true});
}catch(e){res.status(500).json({ok:false,msg:"تعذر تمرير الاتصال"});}});

app.post("/api/private-tutor-rooms/:roomId/admit",async(req,res)=>{try{
  const id=String(req.params.roomId),a=await roomAccess(req,id),participant=String(req.body?.participantId||"");
  if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
  if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});
  if(a.role!=="tutor"&&a.role!=="admin")return res.status(403).json({ok:false,msg:"المعلم فقط يسمح بالدخول"});
  const ps=tutorRoomParticipants.get(id),p=ps?.get(participant);
  if(!p)return res.status(404).json({ok:false,msg:"المشارك غير موجود"});
  p.approved=true;ps.set(participant,p);
  emitRoom(id,"participant-admitted",{participantId:participant,role:p.role});
  emitRoom(id,"presence",{participants:[...ps].map(([participantId,v])=>({participantId,role:v.role,email:v.email,approved:!!v.approved}))});
  res.json({ok:true,participantId:participant});
}catch(e){res.status(500).json({ok:false,msg:"تعذر السماح بالدخول"});}});

app.post("/api/private-tutor-rooms/:roomId/remove-participant",async(req,res)=>{try{
  const id=String(req.params.roomId),a=await roomAccess(req,id),participant=String(req.body?.participantId||"");
  if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
  if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});
  if(a.role!=="tutor"&&a.role!=="admin")return res.status(403).json({ok:false,msg:"المعلم فقط يدير المشاركين"});
  const ps=tutorRoomParticipants.get(id),p=ps?.get(participant);
  if(!p)return res.status(404).json({ok:false,msg:"المشارك غير موجود"});
  if(p.role!=="student")return res.status(403).json({ok:false,msg:"لا يمكن إزالة المعلم"});
  emitRoom(id,"participant-removed",{participantId:participant});
  const clients=tutorRoomClients.get(id);if(clients?.has(participant)){try{clients.get(participant).end();}catch{}clients.delete(participant);}
  ps.delete(participant);
  emitRoom(id,"participant-left",{participantId:participant});
  emitRoom(id,"presence",{participants:[...ps].map(([participantId,v])=>({participantId,role:v.role,email:v.email,approved:!!v.approved}))});
  res.json({ok:true,participantId:participant});
}catch(e){res.status(500).json({ok:false,msg:"تعذر إزالة المشارك"});}});

app.post("/api/private-tutor-rooms/:roomId/recording-state",async(req,res)=>{try{
  const id=String(req.params.roomId),a=await roomAccess(req,id),action=String(req.body?.action||"");
  if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
  if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});
  if(!["started","stopped"].includes(action))return res.status(400).json({ok:false,msg:"حالة التسجيل غير صالحة"});
  const member=[...(tutorRoomParticipants.get(id)||new Map()).values()].find(v=>String(v.email).toLowerCase()===String(a.user.email).toLowerCase());
  if(!member||!member.approved||a.room.status==="ended")return res.status(403).json({ok:false,msg:"يجب أن تكون داخل المحاضرة"});
  const event={state:action,role:a.role,at:Date.now()};
  emitRoom(id,"recording-status",event);
  res.json({ok:true,state:action});
}catch(e){res.status(500).json({ok:false,msg:"تعذر تحديث حالة التسجيل"});}});

app.post("/api/private-tutor-rooms/:roomId/messages",async(req,res)=>{try{
  const id=String(req.params.roomId),a=await roomAccess(req,id),text=String(req.body?.message||"").trim().slice(0,4000);if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});if(!text)return res.status(400).json({ok:false,msg:"الرسالة فارغة"});
  const sender=[...(tutorRoomParticipants.get(id)||new Map()).values()].find(v=>String(v.email).toLowerCase()===String(a.user.email).toLowerCase());if(sender&&!sender.approved)return res.status(403).json({ok:false,msg:"انتظر موافقة المعلم أولاً"});
  const r=await db.query("INSERT INTO private_tutor_messages (id,room_id,sender_email,sender_role,message,created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",[tutorMsgId(),id,a.user.email,a.role,text,Date.now()]);const x=r.rows[0],msg={id:x.id,roomId:x.room_id,senderEmail:x.sender_email,senderRole:x.sender_role,message:x.message,createdAt:Number(x.created_at)};emitRoom(id,"chat-message",msg);res.status(201).json({ok:true,message:msg});
}catch(e){res.status(500).json({ok:false,msg:"تعذر إرسال الرسالة"});}});
app.get("/api/private-tutor-rooms/:roomId/messages",async(req,res)=>{try{const a=await roomAccess(req,String(req.params.roomId));if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});const r=await db.query("SELECT * FROM private_tutor_messages WHERE room_id=$1 ORDER BY created_at ASC LIMIT 500",[a.room.id]);res.json({ok:true,messages:r.rows.map(x=>({id:x.id,roomId:x.room_id,senderEmail:x.sender_email,senderRole:x.sender_role,message:x.message,createdAt:Number(x.created_at)}))});}catch(e){res.status(500).json({ok:false,messages:[]});}});

app.post("/api/private-tutor-rooms/:roomId/recordings",async(req,res)=>{try{
  const a=await roomAccess(req,String(req.params.roomId)),url=String(req.body?.recordingUrl||"").trim();if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});if(a.role==="student"&&![...(tutorRoomParticipants.get(a.room.id)||new Map()).values()].some(v=>v.email===a.user.email&&v.approved))return res.status(403).json({ok:false,msg:"انتظر موافقة المعلم أولاً"});if(!/^https?:\/\//i.test(url))return res.status(400).json({ok:false,msg:"رابط التسجيل غير صالح"});
  const duration=Math.max(0,Math.min(86400,Number(req.body?.durationSec)||0)),size=Math.max(0,Number(req.body?.fileSize)||0),mime=String(req.body?.mimeType||"video/webm").slice(0,100);const r=await db.query("INSERT INTO private_tutor_recordings (id,room_id,uploaded_by,recording_url,duration_sec,mime_type,file_size,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[tutorRecId(),a.room.id,a.user.email,url,duration,mime,size,Date.now()]);const rec={id:r.rows[0].id,roomId:a.room.id,recordingUrl:url,durationSec:duration,mimeType:mime,fileSize:size,createdAt:Number(r.rows[0].created_at)};emitRoom(a.room.id,"recording-ready",rec);res.status(201).json({ok:true,recording:rec});
}catch(e){res.status(500).json({ok:false,msg:"تعذر حفظ التسجيل"});}});
app.post("/api/private-tutor-rooms/:roomId/recordings/upload",async(req,res)=>{try{
  const roomId=String(req.params.roomId),a=await roomAccess(req,roomId),raw=String(req.body?.recordingData||"");
  if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
  if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});
  if(a.role==="student"&&![...(tutorRoomParticipants.get(roomId)||new Map()).values()].some(v=>v.email===a.user.email&&v.approved))return res.status(403).json({ok:false,msg:"انتظر موافقة المعلم أولاً"});
  const match=/^data:(video\/(?:webm|mp4))(?:;[^;]*)*;base64,([\s\S]+)$/i.exec(raw);
  if(!match)return res.status(400).json({ok:false,msg:"ملف التسجيل غير صالح"});
  const buffer=Buffer.from(match[2],"base64");
  if(!buffer.length||buffer.length>68*1024*1024)return res.status(413).json({ok:false,msg:"حجم التسجيل أكبر من الحد الآمن 68MB"});
  const mediaType=String(match[1]||"video/webm").toLowerCase();
  if(!["video/webm","video/mp4"].includes(mediaType))return res.status(415).json({ok:false,msg:"صيغة التسجيل غير مدعومة"});
  const id=tutorRecId(),mime=mediaType;
  const url="/api/private-tutor-rooms/"+roomId+"/recordings/"+id+"/file";
  const r=await db.query(
    "INSERT INTO private_tutor_recordings (id,room_id,uploaded_by,recording_url,duration_sec,mime_type,file_size,file_path,recording_data,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'',$8,$9) RETURNING *",
    [id,roomId,a.user.email,url,Math.max(0,Math.min(86400,Number(req.body?.durationSec)||0)),mime,buffer.length,buffer,Date.now()]
  );
  const rec={id:r.rows[0].id,roomId,recordingUrl:url,durationSec:Number(r.rows[0].duration_sec)||0,mimeType:mime,fileSize:buffer.length,createdAt:Number(r.rows[0].created_at)};
  emitRoom(roomId,"recording-ready",rec);res.status(201).json({ok:true,recording:rec});
}catch(e){console.error("recording upload",e.message);res.status(500).json({ok:false,msg:"تعذر رفع التسجيل"});}});
app.get("/api/private-tutor-rooms/:roomId/recordings/:recordingId/file",async(req,res)=>{try{
  const a=await roomAccess(req,String(req.params.roomId));if(!a.user)return res.status(401).end();if(!a.room||!a.role)return res.status(403).end();
  if(a.role==="student"&&![...(tutorRoomParticipants.get(a.room.id)||new Map()).values()].some(v=>v.email===a.user.email&&v.approved))return res.status(403).end();
  const q=await db.query("SELECT file_path,mime_type,recording_data FROM private_tutor_recordings WHERE id=$1 AND room_id=$2 LIMIT 1",[String(req.params.recordingId),a.room.id]);
  if(!q.rows.length)return res.status(404).end();
  res.type(q.rows[0].mime_type||"video/webm");
  res.set("Cache-Control","private, no-store");
  if(q.rows[0].recording_data)return res.send(q.rows[0].recording_data);
  if(!q.rows[0].file_path)return res.status(404).end();
  res.sendFile(q.rows[0].file_path);
}catch(e){res.status(500).end();}});
app.get("/api/private-tutor-rooms/:roomId/recordings",async(req,res)=>{try{const a=await roomAccess(req,String(req.params.roomId));if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});if(a.role==="student"&&![...(tutorRoomParticipants.get(a.room.id)||new Map()).values()].some(v=>v.email===a.user.email&&v.approved))return res.status(403).json({ok:false,msg:"انتظر موافقة المعلم أولاً"});const r=await db.query("SELECT id,room_id,recording_url,duration_sec,mime_type,file_size,created_at FROM private_tutor_recordings WHERE room_id=$1 ORDER BY created_at DESC",[a.room.id]);res.json({ok:true,recordings:r.rows.map(x=>({id:x.id,roomId:x.room_id,recordingUrl:x.recording_url,durationSec:Number(x.duration_sec)||0,mimeType:x.mime_type,fileSize:Number(x.file_size)||0,createdAt:Number(x.created_at)}))});}catch(e){res.status(500).json({ok:false,recordings:[]});}});

app.post("/api/private-tutor-rooms/:roomId/end",async(req,res)=>{try{
  const a=await roomAccess(req,String(req.params.roomId));
  if(!a.user)return res.status(401).json({ok:false,msg:"سجل الدخول أولاً"});
  if(!a.room||!a.role)return res.status(403).json({ok:false,msg:"غير مصرح"});
  if(a.role!=="tutor"&&a.role!=="admin")return res.status(403).json({ok:false,msg:"المعلم فقط ينهي الدرس"});
  const t=Date.now();
  const r=await db.query("UPDATE private_tutor_rooms SET status='ended',ended_at=$1 WHERE id=$2 RETURNING *",[t,a.room.id]);
  if(a.room.booking_id)await db.query("UPDATE private_tutor_bookings SET status='completed',responded_at=$1 WHERE id=$2 AND status='confirmed'",[t,a.room.booking_id]);
  emitRoom(a.room.id,"room-ended",{roomId:a.room.id,endedAt:t});
  res.json({ok:true,room:roomView(r.rows[0])});
}catch(e){res.status(500).json({ok:false,msg:"تعذر إنهاء الدرس"});}});


// API 404 — طلبات /api غير الموجودة تعيد JSON وليس HTML
app.use("/api", (_req, res) => {
  res.status(404).json({ ok: false, error: "endpoint not found" });
});

// Global error handler — يمنع انهيار السيرفر
app.use((err, _req, res, next) => {
  console.error("❌ خطأ غير متوقع:", err?.message || err);
  if (res.headersSent || res.writableEnded) return next(err);
  res.status(500).json({ ok: false, error: "server error" });
});

// SPA fallback — للصفحات الأمامية فقط
app.use((_req, res) => {
  const htmlPath  = path.join(__dirname, "public", "index.html");
  const htmlPath2 = path.join(__dirname, "..", "public", "index.html");
  res.sendFile(htmlPath, (err) => {
    if (!err) return;
    if (res.headersSent || res.writableEnded) return;
    res.sendFile(htmlPath2, (err2) => {
      if (res.headersSent || res.writableEnded) return;
      if (err2) res.status(200).send("<h1>A+ Medical Platform</h1>");
    });
  });
});

// ══════════════════════════════════════════════
// 19. Anti-Sleep — يمنع Render من النوم
// ══════════════════════════════════════════════
function startAntiSleep() {
  const selfUrl = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
  if (!selfUrl || shuttingDown) return;
  antiSleepTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      const url = selfUrl.replace(/\/$/, "") + "/ping";
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
    } catch {}
  }, 4 * 60 * 1000); // كل 4 دقائق
  antiSleepTimer.unref?.();
  console.log("🔄 Anti-sleep مفعّل →", selfUrl);
}

// ══════════════════════════════════════════════
// 20. Cleanup تلقائي — يُنظّف الجلسات القديمة
// ══════════════════════════════════════════════
function startCleanup() {
  if (shuttingDown) return;
  cleanupTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      const now = Date.now();
      const cutoff = now - 30 * 24 * 60 * 60 * 1000; // 30 يوم
      await db.query("DELETE FROM sessions WHERE created_at < $1", [cutoff]);
      for (const [key, usage] of aiUsage) {
        if (!usage || now - Number(usage.dayStart || 0) >= 86_400_000) {
          aiUsage.delete(key);
        }
      }
      for (const [token, cached] of sessionCache) {
        if (!cached || now - Number(cached.ts || 0) >= SESSION_CACHE_TTL) {
          sessionCache.delete(token);
        }
      }
    } catch {}
  }, 6 * 60 * 60 * 1000); // كل 6 ساعات
  cleanupTimer.unref?.();
}

// ══════════════════════════════════════════════
// 21. التشغيل
// ══════════════════════════════════════════════
// معالجة أخطاء Express غير المعالجة دون كشف التفاصيل للمستخدم.
app.use((error, req, res, next) => {
  const statusCode = Number(error?.status) || 500;
  const errorNumber = classifySupportError({
    message: error?.message || "",
    statusCode,
  });
  if (res.headersSent) return next(error);
  res.locals.applicationErrorCaptured = true;
  void recordApplicationError({
    req,
    category: supportErrorCategory(errorNumber),
    message: error?.message || "Unhandled server error",
    stack: error?.stack || "",
    source: "server",
    path: req.originalUrl || req.path,
    method: req.method,
    statusCode,
  });
  const clientError = statusCode >= 400 && statusCode < 500;
  return res.status(clientError ? statusCode : 500).json({
    ok: false,
    msg: clientError
      ? "بيانات الطلب غير صالحة. حدّث الصفحة ثم أعد المحاولة."
      : "حدث خطأ غير متوقع في الخادم",
    errorNumber,
  });
});

const PORT = parseInt(process.env.PORT || "3000", 10);

// افتح المنفذ أولاً حتى يستجيب Render للفحص، ثم جهّز قاعدة البيانات
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 A+ Medical Server v5.0 يعمل على المنفذ ${PORT}`);
  console.log(`🔴 بث مباشر SSE مفعّل`);
  startAntiSleep();
  startCleanup();
});

// Keep-alive للـ HTTP server
server.keepAliveTimeout = 120_000;
server.headersTimeout   = 125_000;

dbInitPromise = initDB()
  .then(() => {
    dbReady = true;
    console.log(`💎 قاعدة البيانات متصلة`);
  })
  .catch((err) => {
    console.error("❌ فشل تشغيل قاعدة البيانات:", err?.message || err);
    dbInitError = err;
    void recordApplicationError({
      category: "database",
      message: `فشل تهيئة قاعدة البيانات: ${err?.message || "unknown"}`,
      stack: err?.stack || "",
      source: "monitor",
      path: "/api/healthz",
      statusCode: 503,
    });
  })
  .finally(() => startErrorWatchdog());

// إغلاق نظيف وآمن: أوقف المؤقتات والطلبات الجديدة قبل إنهاء اتصال قاعدة البيانات.
function shutdownServer(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true;
  console.log(`⏹ إغلاق نظيف (${signal})...`);
  if (watchdogTimer) clearInterval(watchdogTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (antiSleepTimer) clearInterval(antiSleepTimer);

  const closePool = () => {
    void pool.end().catch((error) => {
      console.error("❌ تعذر إغلاق اتصال قاعدة البيانات:", error?.message || error);
    });
  };
  if (server.listening) server.close(closePool);
  else closePool();
}
process.once("SIGTERM", () => shutdownServer("SIGTERM"));
process.once("SIGINT", () => shutdownServer("SIGINT"));
