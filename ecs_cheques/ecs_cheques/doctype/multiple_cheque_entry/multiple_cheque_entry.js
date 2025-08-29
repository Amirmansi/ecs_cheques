// Copyright (c) 2021, erpcloud.systems and contributors
// For license information, please see license.txt

frappe.ui.form.on("Multiple Cheque Entry", {
    setup: function(frm) {
        frm.set_query("bank_acc", () => ({
            filters: [["Bank Account", "bank", "in", frm.doc.cheque_bank]]
        }));
        frm.set_query("cheque_bank", () => ({
            filters: [["Bank", "company_bank", "=", '1']]
        }));
        frm.set_query("mode_of_payment", () => ({
            filters: [["Mode of Payment", "type", "=", 'Cheque']]
        }));
        frm.set_query("party_type", () => ({
            filters: [["DocType", "name", "in", ["Customer", "Supplier"]]]
        }));
    }
});

frappe.ui.form.on("Multiple Cheque Entry", {
    party_type: function(frm) {
        frm.set_value("party", "");
        frm.set_value("party_name", "");
    },
    cheque_bank: function(frm) {
        frm.set_value("bank_acc", "");
        frm.set_value("account", "");
        frm.set_value("collection_fee_account", "");
        frm.set_value("payable_account", "");
    },
    bank_acc: function(frm) {
        frm.set_value("account", "");
        frm.set_value("collection_fee_account", "");
        frm.set_value("payable_account", "");
    },
    payment_type: function(frm) {
        if (frm.doc.payment_type === "Receive") {
            frm.set_value("party_type", "Customer");
        }
        if (frm.doc.payment_type === "Pay") {
            frm.set_value("party_type", "Supplier");
        }
    },
    party: function(frm) {
        if (!frm.doc.party_type || !frm.doc.party) return;
        const doctype = frm.doc.party_type === "Customer" ? "Customer" : "Supplier";
        const fieldname = frm.doc.party_type === "Customer" ? "customer_name" : "supplier_name";
        frappe.call({
            method: "frappe.client.get_value",
            args: { doctype, fieldname, filters: { name: frm.doc.party } },
            callback: function(r) {
                frm.set_value("party_name", r.message ? r.message[fieldname] : "");
            }
        });
    },
    validate: function(frm) {
        if (frm.doc.mode_of_payment_type !== "Cheque") {
            frappe.throw("The selected Mode of Payment is not Cheque. Please select a Cheque type.");
        }
    }
});

// -------- Helper: build robust Payment Entry data --------
function buildPaymentEntryTemplate(frm, row, isPay, isReceive, accountPaidTo, accountCurrency) {
    // Choose sensible paid_from / paid_to defaults and allow user overrides
    const paid_to_value = accountPaidTo || frm.doc.paid_to || frm.doc.payable_account || frm.doc.account || frm.doc.bank_acc;
    const paid_from_value = (isReceive ? (frm.doc.paid_from || frm.doc.account || frm.doc.bank_acc) : (frm.doc.payable_account || frm.doc.account || frm.doc.bank_acc));

    // Base payload (common fields)
    const base = {
        doctype: "Payment Entry",
        posting_date: frm.doc.posting_date || frm.doc.transaction_date || frm.doc.posting_date,
        payment_type: frm.doc.payment_type,
        mode_of_payment: frm.doc.mode_of_payment,
        mode_of_payment_type: frm.doc.mode_of_payment_type,
        party_type: frm.doc.party_type,
        party: frm.doc.party,
        // main account links commonly used by Payment Entry
        paid_from: paid_from_value,
        paid_to: paid_to_value,
        cheque_bank: frm.doc.cheque_bank,
        bank_acc: frm.doc.bank_acc,
        paid_amount: row.paid_amount || row.amount || 0,
        received_amount: row.paid_amount || row.amount || 0,
        reference_no: row.reference_no,
        reference_date: row.reference_date,
        first_beneficiary: row.first_beneficiary || row.first_beneficiary,
        person_name: row.person_name,
        issuer_name: row.issuer_name,
        picture_of_check: row.picture_of_check,
        reference_doctype: "Multiple Cheque Entry",
        reference_link: frm.doc.name
    };

    // Add a variety of alternate fieldnames for "Account Paid To" and its currency
    // (many ERPNext versions/customizations use slightly different names).
    // We fill as many plausible names as possible so validation can find a value.
    const alternates = {
        // account name variants
        paid_to_account: base.paid_to,
        account_paid_to: base.paid_to,
        account_paid_to_name: base.paid_to,
        paid_to_account_name: base.paid_to,

        // currency name variants
        paid_to_account_currency: accountCurrency || frm.doc.account_currency || frm.doc.currency || frm.doc.account_currency_to,
        account_paid_to_currency: accountCurrency || frm.doc.account_currency || frm.doc.currency,
        paid_to_currency: accountCurrency || frm.doc.account_currency || frm.doc.currency,
        account_currency_to: accountCurrency || frm.doc.account_currency || frm.doc.currency
    };

    // merge base + alternates. alternates added last so they are present in payload.
    return Object.assign({}, base, alternates, {
        // child link: keep track of which cheque row this corresponds to
        cheque_table_no: isReceive ? row.name : undefined,
        cheque_table_no2: isPay ? row.name : undefined
    });
}

// -------- On Submit for Payment Entries --------
frappe.ui.form.on("Multiple Cheque Entry", "on_submit", function(frm) {
    const isPay = frm.doc.payment_type === "Pay";
    const isReceive = frm.doc.payment_type === "Receive";
    const table = isPay ? frm.doc.cheque_table_2 : frm.doc.cheque_table;
    if (!table || !table.length) {
        frappe.msgprint({ title: __('No Cheques'), message: __('لا توجد شيكات لإنشاء قيد دفع/قبض.') });
        return;
    }

    // Your custom fields (labels -> expected fieldnames)
    const accountPaidTo = frm.doc.account_paid_to || frm.doc.account_paid || frm.doc.account_paid_to_field || frm.doc.account_paid_to_name;
    const accountCurrency = frm.doc.account_currency || frm.doc.currency || frm.doc.account_currency_field;

    // Validate presence before trying many inserts
    if (!accountPaidTo && !frm.doc.paid_to && !frm.doc.payable_account && !frm.doc.account && !frm.doc.bank_acc) {
        frappe.msgprint({
            title: __('Missing Account'),
            message: __('لم يتم تحديد حساب "Account Paid To" أو أي حساب بديل (كالـ Paid To / Payable Account / Account). الرجاء تحديد الحساب.')
        });
        return;
    }

    // Build all docs to insert
    const docs = table.filter(r => !r.payment_entry).map(row => buildPaymentEntryTemplate(frm, row, isPay, isReceive, accountPaidTo, accountCurrency));

    // Insert & submit sequentially to better catch and report errors per document
    let chain = Promise.resolve();
    docs.forEach(docPayload => {
        chain = chain.then(() => new Promise((resolve, reject) => {
            frappe.call({
                method: "frappe.client.insert",
                args: { doc: docPayload },
                callback: function(inserted) {
                    if (!inserted || !inserted.message) {
                        // collect server response for debugging if any
                        const errMsg = (inserted && inserted.exc) ? inserted.exc : "Unknown insert error";
                        console.error("Insert failed:", errMsg, inserted);
                        frappe.msgprint({ title: __('Insert Error'), message: __('فشل إدخال قيد الدفع: ') + errMsg });
                        return reject(errMsg);
                    }

                    // now submit the inserted doc
                    frappe.call({
                        method: "frappe.client.submit",
                        args: { doc: inserted.message },
                        callback: function(submitted) {
                            if (!submitted || !submitted.message) {
                                const err2 = (submitted && submitted.exc) ? submitted.exc : "Unknown submit error";
                                console.error("Submit failed:", err2, submitted);
                                frappe.msgprint({ title: __('Submit Error'), message: __('فشل تقديم قيد الدفع: ') + err2 });
                                return reject(err2);
                            }

                            // On success: set payment_entry back on child cheque row (try both child doctypes)
                            const child_doctype = isPay ? "Cheque Table Pay" : "Cheque Table Receive";
                            const child_name = docPayload.cheque_table_no || docPayload.cheque_table_no2;
                            if (child_name) {
                                frappe.db.set_value(child_doctype, child_name, "payment_entry", submitted.message.name)
                                    .then(() => resolve(submitted.message))
                                    .catch(e => {
                                        console.error("Failed to set child payment_entry:", e);
                                        // still resolve because the Payment Entry was created and submitted
                                        resolve(submitted.message);
                                    });
                            } else {
                                resolve(submitted.message);
                            }
                        },
                        error: function(err) {
                            console.error("Submit call error:", err);
                            frappe.msgprint({ title: __('Submit RPC Error'), message: JSON.stringify(err) });
                            reject(err);
                        }
                    });
                },
                error: function(err) {
                    console.error("Insert call error:", err);
                    frappe.msgprint({ title: __('Insert RPC Error'), message: JSON.stringify(err) });
                    reject(err);
                }
            });
        }));
    });

    chain.then(results => {
        frappe.msgprint("تم إنشاء الشيكات بنجاح ... برجاء مراجعة المدفوعات والمقبوضات.");
        frm.reload_doc();
    }).catch(err => {
        // Final catch: log and inform
        console.error("One or more Payment Entries failed:", err);
        frappe.msgprint({ title: __('Error'), message: __('حدث خطأ أثناء إنشاء أو تقديم قيود الدفع. راجع السجل أو سجل المتصفح للحصول على مزيد من التفاصيل.') });
    });
});

// -------- First Beneficiary Auto-Fill --------
frappe.ui.form.on("Cheque Table Pay", "first_beneficiary", function(frm) {
    frm.doc.cheque_table_2?.forEach(r => {
        r.person_name = frm.doc.party_name;
        r.issuer_name = frm.doc.company;
    });
    frm.refresh_field("cheque_table_2");
});

frappe.ui.form.on("Cheque Table Receive", "first_beneficiary", function(frm) {
    frm.doc.cheque_table?.forEach(r => {
        r.person_name = frm.doc.company;
        r.issuer_name = frm.doc.party_name;
    });
    frm.refresh_field("cheque_table");
});
