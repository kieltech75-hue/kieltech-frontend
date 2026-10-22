import json
import logging
import os


logger = logging.getLogger('kieltech.firebase_roles')
FIREBASE_PROJECT_ID = 'kieltech-71377'


class FirebaseConfigurationError(RuntimeError):
    pass


class FirebaseRoleResolutionError(RuntimeError):
    pass


def _firestore_role_document(uid: str):
    from firebase_admin import firestore

    app = get_firebase_app()
    return firestore.client(app=app).collection('user_roles').document(uid)


def get_firebase_app():
    try:
        import firebase_admin
        from firebase_admin import credentials
    except ImportError as exc:
        raise FirebaseConfigurationError('Firebase Admin SDK is not installed.') from exc

    project_id = (os.getenv('FIREBASE_PROJECT_ID') or FIREBASE_PROJECT_ID).strip()
    service_account_json = os.getenv('FIREBASE_SERVICE_ACCOUNT_JSON', '').strip()
    if not service_account_json:
        raise FirebaseConfigurationError('Configure FIREBASE_SERVICE_ACCOUNT_JSON on the backend.')

    try:
        service_account_info = json.loads(service_account_json)
        if not isinstance(service_account_info, dict) or service_account_info.get('project_id') != project_id:
            raise FirebaseConfigurationError(
                'FIREBASE_SERVICE_ACCOUNT_JSON must belong to the configured Firebase project.'
            )
        try:
            app = firebase_admin.get_app()
            if app.project_id and app.project_id != project_id:
                raise FirebaseConfigurationError('Firebase Admin SDK is initialized for a different project.')
            return app
        except ValueError:
            credential = credentials.Certificate(service_account_info)
            return firebase_admin.initialize_app(credential, {'projectId': project_id})
    except FirebaseConfigurationError:
        raise
    except Exception as exc:
        raise FirebaseConfigurationError(
            'Firebase Admin credentials are unavailable. Check FIREBASE_SERVICE_ACCOUNT_JSON.'
        ) from exc


def get_firebase_role(uid: str | None) -> str:
    normalized_uid = (uid or '').strip()
    if not normalized_uid:
        return 'user'

    try:
        from firebase_admin import auth as firebase_auth

        app = get_firebase_app()
        try:
            firebase_user = firebase_auth.get_user(normalized_uid, app=app)
        except Exception as exc:
            if type(exc).__name__ == 'UserNotFoundError':
                return 'user'
            raise
        if firebase_user.disabled:
            return 'user'
        role = _firestore_role_document(normalized_uid).get()
        role_data = role.to_dict() if role.exists else None
        role_name = str((role_data or {}).get('role') or '').strip().lower()
        return role_name if role_name in {'admin', 'owner'} else 'user'
    except FirebaseRoleResolutionError:
        raise
    except Exception as exc:
        logger.exception('Unable to resolve the current Firestore role for Firebase UID %s', normalized_uid)
        raise FirebaseRoleResolutionError('Unable to verify the account role with Firebase.') from exc


def is_firebase_admin_uid(uid: str | None) -> bool:
    return get_firebase_role(uid) in {'admin', 'owner'}


def is_firebase_owner_uid(uid: str | None) -> bool:
    return get_firebase_role(uid) == 'owner'


def list_firebase_admin_uids() -> set[str]:
    try:
        from firebase_admin import firestore

        app = get_firebase_app()
        roles = firestore.client(app=app).collection('user_roles').stream()
        return {
            document.id
            for document in roles
            if document.id and (document.to_dict() or {}).get('role') in {'admin', 'owner'}
        }
    except Exception as exc:
        logger.exception('Unable to list privileged roles from Firestore')
        raise FirebaseRoleResolutionError('Unable to load account roles from Firestore.') from exc


def list_firebase_roles() -> dict[str, str]:
    try:
        from firebase_admin import firestore

        app = get_firebase_app()
        documents = firestore.client(app=app).collection('user_roles').stream()
        return {
            document.id: role_name
            for document in documents
            if document.id
            and (role_name := str((document.to_dict() or {}).get('role') or '').strip().lower())
            in {'admin', 'owner'}
        }
    except Exception as exc:
        logger.exception('Unable to list user roles from Firestore')
        raise FirebaseRoleResolutionError('Unable to load user roles from Firestore.') from exc


def set_firebase_admin_role(uid: str, enabled: bool) -> str:
    normalized_uid = (uid or '').strip()
    if not normalized_uid:
        raise ValueError('A Firebase user ID is required.')

    try:
        from firebase_admin import auth as firebase_auth

        app = get_firebase_app()
        firebase_user = firebase_auth.get_user(normalized_uid, app=app)
        if firebase_user.disabled:
            raise ValueError('This Google-linked account is disabled and cannot be assigned an admin role.')

        role_document = _firestore_role_document(normalized_uid)
        snapshot = role_document.get()
        current_role = str(((snapshot.to_dict() if snapshot.exists else {}) or {}).get('role') or '').strip().lower()
        if current_role == 'owner':
            raise ValueError('Owner roles cannot be changed from the owner management page.')
        if enabled:
            role_document.set({'role': 'admin'})
            return 'admin'
        if current_role == 'admin':
            role_document.delete()
        return 'user'
    except ValueError:
        raise
    except Exception as exc:
        logger.exception('Unable to update Firestore admin role for Firebase UID %s', normalized_uid)
        raise FirebaseRoleResolutionError('Unable to update the user role in Firestore.') from exc
