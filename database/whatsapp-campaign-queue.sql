-- Apply AFTER whatsapp-delivery-errors.sql, BEFORE the campaign-queue deployment.
-- Rerunnable. Existing campaigns are NOT queued or retried by this migration.
BEGIN;
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS queue_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS request_key uuid,
  ADD COLUMN IF NOT EXISTS request_fingerprint text,
  ADD COLUMN IF NOT EXISTS sender_phone_number_id text,
  ADD COLUMN IF NOT EXISTS template_components jsonb,
  ADD COLUMN IF NOT EXISTS header_image_url text,
  ADD COLUMN IF NOT EXISTS queued_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS uncertain_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_count integer NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_request_key ON public.campaigns(request_key) WHERE request_key IS NOT NULL;
ALTER TABLE public.campaign_logs DROP CONSTRAINT IF EXISTS campaign_logs_status_check;
ALTER TABLE public.campaign_logs ADD CONSTRAINT campaign_logs_status_check
  CHECK (status IN ('queued','sending','uncertain','skipped','sent','delivered','read','failed'));
ALTER TABLE public.campaign_logs ADD COLUMN IF NOT EXISTS dispatch_token uuid,
  ADD COLUMN IF NOT EXISTS dispatch_lease_until timestamptz;
CREATE INDEX IF NOT EXISTS idx_campaign_queued ON public.campaign_logs(campaign_id,created_at,id) WHERE status='queued';

CREATE TABLE IF NOT EXISTS public.whatsapp_campaign_senders (
  phone_number_id text PRIMARY KEY,
  next_send_at timestamptz NOT NULL DEFAULT now(),
  paused_until timestamptz,
  inflight_log uuid REFERENCES public.campaign_logs(id) ON DELETE SET NULL,
  lease_until timestamptz,
  rate_strikes integer NOT NULL DEFAULT 0,
  last_rate_at timestamptz
);
ALTER TABLE public.whatsapp_campaign_senders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_campaign_senders FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.finish_whatsapp_campaign(p_campaign_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v public.campaigns%ROWTYPE; a integer; s integer; d integer; r integer; f integer; q integer; u integer; k integer;
BEGIN
  SELECT * INTO v FROM public.campaigns WHERE id=p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Campaign not found'; END IF;
  SELECT count(*) FILTER (WHERE status<>'skipped'),count(*) FILTER (WHERE wamid IS NOT NULL),
    count(*) FILTER (WHERE delivered_at IS NOT NULL OR status IN ('delivered','read')),
    count(*) FILTER (WHERE read_at IS NOT NULL OR status='read'),count(*) FILTER (WHERE status='failed'),
    count(*) FILTER (WHERE status IN ('queued','sending')),count(*) FILTER (WHERE status='uncertain'),
    count(*) FILTER (WHERE status='skipped') INTO a,s,d,r,f,q,u,k
  FROM public.campaign_logs WHERE campaign_id=p_campaign_id;
  UPDATE public.campaigns SET total_contacts=a,sent_count=s,delivered_count=d,read_count=r,failed_count=f,
    queued_count=q,uncertain_count=u,skipped_count=k,
    status=CASE WHEN q>0 THEN 'running' WHEN a>0 AND f=a THEN 'failed' ELSE 'completed' END,
    completed_at=CASE WHEN q>0 THEN NULL ELSE coalesce(completed_at,now()) END WHERE id=p_campaign_id;
  RETURN jsonb_build_object('campaign_id',p_campaign_id,'total',a,'accepted',s,'delivered',d,'read',r,'failed',f,'queued',q,'uncertain',u,'skipped',k);
END; $$;

CREATE OR REPLACE FUNCTION public.enqueue_whatsapp_campaign(
  p_request_key uuid,p_fingerprint text,p_name text,p_template text,p_language text,
  p_phone_number_id text,p_components jsonb,p_image_url text,p_contacts jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v public.campaigns%ROWTYPE; item jsonb; cid uuid; contact_state text;
BEGIN
  IF p_request_key IS NULL OR p_fingerprint IS NULL OR length(p_fingerprint)<>64 OR p_phone_number_id IS NULL OR p_phone_number_id !~ '^[0-9]{6,32}$'
    OR nullif(p_name,'') IS NULL OR nullif(p_template,'') IS NULL OR nullif(p_language,'') IS NULL
    OR jsonb_typeof(p_components) IS DISTINCT FROM 'array' OR jsonb_typeof(p_contacts) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_contacts) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid campaign'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_key::text,1));
  SELECT * INTO v FROM public.campaigns WHERE request_key=p_request_key;
  IF FOUND THEN
    IF v.request_fingerprint IS DISTINCT FROM p_fingerprint THEN RAISE EXCEPTION 'Campaign request conflict'; END IF;
    RETURN public.finish_whatsapp_campaign(v.id);
  END IF;
  INSERT INTO public.campaigns(name,template_name,template_language,status,queue_enabled,request_key,request_fingerprint,
    sender_phone_number_id,template_components,header_image_url)
  VALUES(p_name,p_template,p_language,'running',true,p_request_key,p_fingerprint,p_phone_number_id,p_components,nullif(p_image_url,'')) RETURNING * INTO v;
  FOR item IN SELECT value FROM jsonb_array_elements(p_contacts) LOOP
    IF coalesce(item->>'phone','') !~ '^\+[0-9]{6,15}$' THEN RAISE EXCEPTION 'Invalid phone'; END IF;
    INSERT INTO public.contacts(phone,name,email) VALUES(item->>'phone',nullif(item->>'name',''),nullif(item->>'email',''))
    ON CONFLICT(phone) DO UPDATE SET name=coalesce(contacts.name,excluded.name),email=coalesce(contacts.email,excluded.email)
    RETURNING id,status INTO cid,contact_state;
    IF NOT EXISTS(SELECT FROM public.campaign_logs WHERE campaign_id=v.id AND contact_id=cid) THEN
      INSERT INTO public.campaign_logs(campaign_id,contact_id,status,error_message)
      VALUES(v.id,cid,CASE WHEN contact_state='active' THEN 'queued' ELSE 'skipped' END,
        CASE WHEN contact_state<>'active' THEN 'Contact is blocked or inactive; not sent.' END);
    END IF;
  END LOOP;
  RETURN public.finish_whatsapp_campaign(v.id);
END; $$;

CREATE OR REPLACE FUNCTION public.pause_whatsapp_campaign_sender(p_phone text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  -- Called with the per-phone row locked. The delay is an operating default,
  -- not a claim that Meta's rate restriction expires at this time.
  UPDATE public.whatsapp_campaign_senders SET rate_strikes=least(7,CASE WHEN last_rate_at<now()-interval '24 hours' THEN 1 ELSE rate_strikes+1 END),
    paused_until=greatest(paused_until,now()+make_interval(secs=>least(3600,60*power(2,least(6,CASE WHEN last_rate_at<now()-interval '24 hours' THEN 0 ELSE rate_strikes END)))::integer)),
    last_rate_at=now() WHERE phone_number_id=p_phone;
END; $$;

CREATE OR REPLACE FUNCTION public.claim_whatsapp_campaign_message(p_campaign_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.campaigns%ROWTYPE; gate public.whatsapp_campaign_senders%ROWTYPE; job public.campaign_logs%ROWTYPE; target public.contacts%ROWTYPE; summary jsonb;
BEGIN
  SELECT * INTO c FROM public.campaigns WHERE id=p_campaign_id;
  IF NOT FOUND OR NOT c.queue_enabled THEN RAISE EXCEPTION 'Queued campaign not found'; END IF;
  INSERT INTO public.whatsapp_campaign_senders(phone_number_id) VALUES(c.sender_phone_number_id) ON CONFLICT DO NOTHING;
  SELECT * INTO gate FROM public.whatsapp_campaign_senders WHERE phone_number_id=c.sender_phone_number_id FOR UPDATE;
  IF gate.inflight_log IS NOT NULL AND gate.lease_until>now() THEN
    RETURN jsonb_build_object('state','wait','wait_ms',2000);
  END IF;
  IF gate.inflight_log IS NOT NULL THEN
    UPDATE public.campaign_logs SET status='uncertain',error_message='A previous send did not finish recording. Check delivery before retrying.'
      WHERE id=gate.inflight_log AND status='sending' RETURNING * INTO job;
    UPDATE public.whatsapp_campaign_senders SET inflight_log=NULL,lease_until=NULL WHERE phone_number_id=c.sender_phone_number_id;
    IF FOUND AND job.id IS NOT NULL THEN
      summary:=public.finish_whatsapp_campaign(job.campaign_id);
      RETURN jsonb_build_object('state','review','message','A previous send needs review; it will not be resent automatically.','summary',summary);
    END IF;
  END IF;
  IF NOT EXISTS(SELECT FROM public.campaign_logs WHERE campaign_id=c.id AND status IN ('queued','sending')) THEN
    summary:=public.finish_whatsapp_campaign(c.id);
    RETURN jsonb_build_object('state','done','summary',summary);
  END IF;
  IF gate.paused_until>now() THEN RETURN jsonb_build_object('state','paused','retry_at',gate.paused_until,'message','Sending paused after Meta rate limit 130429. Remaining recipients are saved.'); END IF;
  IF gate.next_send_at>now() THEN RETURN jsonb_build_object('state','wait','wait_ms',greatest(250,ceil(extract(epoch FROM gate.next_send_at-now())*1000)::integer)); END IF;
  LOOP
    SELECT * INTO job FROM public.campaign_logs WHERE campaign_id=c.id AND status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      summary:=public.finish_whatsapp_campaign(c.id);
      RETURN jsonb_build_object('state','done','summary',summary);
    END IF;
    SELECT * INTO target FROM public.contacts WHERE id=job.contact_id;
    IF target.status='active' THEN EXIT; END IF;
    UPDATE public.campaign_logs SET status='skipped',error_message='Contact is blocked or inactive; not sent.' WHERE id=job.id;
  END LOOP;
  UPDATE public.campaign_logs SET status='sending',dispatch_token=gen_random_uuid(),dispatch_lease_until=now()+interval '90 seconds',sent_at=now()
    WHERE id=job.id RETURNING * INTO job;
  UPDATE public.whatsapp_campaign_senders SET inflight_log=job.id,lease_until=job.dispatch_lease_until,next_send_at=now()+interval '5 seconds'
    WHERE phone_number_id=c.sender_phone_number_id;
  RETURN jsonb_build_object('state','claimed','log_id',job.id,'dispatch_token',job.dispatch_token,'phone',target.phone,
    'phone_number_id',c.sender_phone_number_id,'template',c.template_name,'language',c.template_language,'components',c.template_components);
END; $$;

CREATE OR REPLACE FUNCTION public.complete_whatsapp_campaign_message(
  p_log_id uuid,p_token uuid,p_wamid text,p_error text,p_uncertain boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE job public.campaign_logs%ROWTYPE; c public.campaigns%ROWTYPE; snapshot jsonb; is_rate boolean;
BEGIN
  SELECT ca.* INTO c FROM public.campaigns ca JOIN public.campaign_logs l ON l.campaign_id=ca.id WHERE l.id=p_log_id;
  IF NOT FOUND OR NOT c.queue_enabled THEN RAISE EXCEPTION 'Queued message not found'; END IF;
  PERFORM 1 FROM public.whatsapp_campaign_senders WHERE phone_number_id=c.sender_phone_number_id FOR UPDATE;
  SELECT * INTO job FROM public.campaign_logs WHERE id=p_log_id FOR UPDATE;
  IF job.dispatch_token IS DISTINCT FROM p_token OR p_token IS NULL THEN RAISE EXCEPTION 'Dispatch token mismatch'; END IF;
  IF job.status NOT IN ('sending','uncertain') THEN RETURN public.finish_whatsapp_campaign(c.id); END IF;
  IF p_wamid IS NOT NULL AND (length(p_wamid) NOT BETWEEN 1 AND 512 OR p_uncertain) THEN RAISE EXCEPTION 'Invalid send result'; END IF;
  UPDATE public.campaign_logs SET wamid=p_wamid,status=CASE WHEN p_uncertain THEN 'uncertain' WHEN p_wamid IS NOT NULL THEN 'sent' ELSE 'failed' END,
    error_message=CASE WHEN p_wamid IS NULL THEN left(p_error,2000) END WHERE id=p_log_id;
  IF NOT p_uncertain THEN
    INSERT INTO public.messages(contact_id,campaign_id,wamid,direction,content,media_url,status,sent_at)
      VALUES(job.contact_id,c.id,p_wamid,'outbound','📢 '||c.name||' — Template: '||c.template_name,c.header_image_url,
        CASE WHEN p_wamid IS NOT NULL THEN 'sent' ELSE 'failed' END,job.sent_at);
    IF p_wamid IS NOT NULL THEN UPDATE public.contacts SET last_message_at=greatest(last_message_at,job.sent_at) WHERE id=job.contact_id; END IF;
  END IF;
  IF p_wamid IS NULL AND NOT p_uncertain AND coalesce(p_error,'') LIKE '%(#130429)%' THEN
    PERFORM public.pause_whatsapp_campaign_sender(c.sender_phone_number_id);
  END IF;
  UPDATE public.whatsapp_campaign_senders SET inflight_log=NULL,lease_until=NULL,next_send_at=greatest(next_send_at,now()+interval '5 seconds')
    WHERE phone_number_id=c.sender_phone_number_id AND inflight_log=p_log_id;
  snapshot:=public.finish_whatsapp_campaign(c.id);
  RETURN snapshot;
END; $$;

-- A receipt may precede the update that attaches a wamid to its queued log.
CREATE OR REPLACE FUNCTION public.reconcile_whatsapp_campaign_log_wamid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.wamid IS NOT NULL AND NEW.wamid IS DISTINCT FROM OLD.wamid THEN PERFORM public.flush_whatsapp_pending_statuses(NEW.wamid); END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS campaign_logs_reconcile_whatsapp_wamid ON public.campaign_logs;
CREATE TRIGGER campaign_logs_reconcile_whatsapp_wamid AFTER UPDATE OF wamid ON public.campaign_logs
FOR EACH ROW EXECUTE FUNCTION public.reconcile_whatsapp_campaign_log_wamid();

CREATE OR REPLACE FUNCTION public.record_whatsapp_status_with_queue(
  p_phone_number_id text,p_wamid text,p_status text,p_at timestamptz,p_error_message text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE fresh_rate boolean;
BEGIN
  IF p_phone_number_id IS NULL OR p_phone_number_id !~ '^[0-9]{6,32}$' THEN RAISE EXCEPTION 'Invalid sender identity'; END IF;
  INSERT INTO public.whatsapp_campaign_senders(phone_number_id) VALUES(p_phone_number_id) ON CONFLICT DO NOTHING;
  -- Same lock order as completion: sender row, then receipt/message locks.
  PERFORM 1 FROM public.whatsapp_campaign_senders WHERE phone_number_id=p_phone_number_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_wamid,0));
  fresh_rate:=p_status='failed' AND coalesce(p_error_message,'') LIKE '%(#130429)%'
    AND NOT EXISTS(SELECT FROM public.whatsapp_pending_statuses WHERE wamid=p_wamid AND status='failed' AND error_message LIKE '%(#130429)%');
  PERFORM public.record_whatsapp_status_with_error(p_wamid,p_status,p_at,p_error_message);
  IF fresh_rate AND NOT EXISTS(SELECT FROM public.messages WHERE wamid=p_wamid AND status IN ('delivered','read'))
    AND NOT EXISTS(SELECT FROM public.campaign_logs WHERE wamid=p_wamid AND status IN ('delivered','read')) THEN
    PERFORM public.pause_whatsapp_campaign_sender(p_phone_number_id);
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.whatsapp_campaign_queue_version() RETURNS integer LANGUAGE sql AS $$ SELECT 1; $$;
REVOKE ALL ON FUNCTION public.pause_whatsapp_campaign_sender(text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.reconcile_whatsapp_campaign_log_wamid() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.enqueue_whatsapp_campaign(uuid,text,text,text,text,text,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_whatsapp_campaign_message(uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.complete_whatsapp_campaign_message(uuid,uuid,text,text,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.record_whatsapp_status_with_queue(text,text,text,timestamptz,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.whatsapp_campaign_queue_version() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_whatsapp_campaign(uuid,text,text,text,text,text,jsonb,text,jsonb),
  public.claim_whatsapp_campaign_message(uuid),public.complete_whatsapp_campaign_message(uuid,uuid,text,text,boolean),
  public.record_whatsapp_status_with_queue(text,text,text,timestamptz,text),public.whatsapp_campaign_queue_version() TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
